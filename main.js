'use strict';

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const Json2iob = require('json2iob');
const { createHTTP2Adapter } = require('axios-http2-adapter');
const http2 = require('http2-wrapper');
const crypto = require('crypto');

class Libre extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: 'libre',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.deviceArray = [];
    this.json2iob = new Json2iob(this);

    const adapterConfig = {
      agent: new http2.Agent({
        /* options */
      }),
      force: true, // Force HTTP/2 without ALPN check - adapter will not check whether the endpoint supports http2 before the request
    };

    axios.defaults.adapter = createHTTP2Adapter(adapterConfig);
    this.requestClient = axios.create();
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    if (this.config.interval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.interval = 0.5;
    }
    if (!this.config.username || !this.config.password) {
      this.log.error('Please set username and password in the instance settings');
      return;
    }
    if (this.config.version) {
      if (this.config.version === '4.10.0') {
        this.config.version = '4.12.0';
      }
    }
    this.header = {
      'content-type': 'application/json',
      pragma: 'no-cache',
      accept: '*/*',
      version: this.config.version || '4.12.0',
      product: 'llu.ios',
      'account-id': '',
      'cache-control': 'no-cache',
      'accept-language': 'de-DE,de;q=0.9',
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU OS 16_7.7 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/16.7.7 Mobile/10A5355d Safari/8536.25',
    };
    this.log.info(`Using version ${this.config.version || '4.10.0'} please update to the latest version of the app if necessary`);
    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.session = {};
    this.subscribeStates('*');

    await this.login();

    if (this.session.token) {
      await this.getDeviceList();
      await this.updateDevices();
      this.updateInterval = setInterval(async () => {
        await this.updateDevices();
      }, this.config.interval * 60 * 1000);
      this.refreshTokenInterval = setInterval(() => {
        this.refreshToken();
      }, 22 * 60 * 60 * 1000);
      this.generalInterval = this.setInterval(() => {
        this.getDeviceList();
      }, 23.9 * 60 * 60 * 1000);
    }
  }
  async login() {
    await this.requestClient({
      method: 'post',
      url: 'https://api-' + this.config.region + '.libreview.io/llu/auth/login',
      headers: this.header,
      data: {
        email: this.config.username,
        password: this.config.password,
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.status !== 0) {
          this.log.error('Login failed. Please check your credentials and logout and login to the app and accept the terms of use.');
          return;
        }
        if (res.data.data && res.data.data.authTicket) {
          this.session = res.data.data.authTicket;
          this.header.Authorization = 'Bearer ' + this.session.token;
          //set sha256 hash from id set as accountid
          this.header['account-id'] = crypto.createHash('sha256').update(res.data.data.user.id).digest('hex');
          this.setState('info.connection', true, true);
          return;
        }
        this.log.error(JSON.stringify(res.data));
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  async getDeviceList() {
    await this.requestClient({
      method: 'get',
      url: 'https://api-' + this.config.region + '.libreview.io/llu/connections',
      headers: this.header,
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.data.length === 0) {
          this.log.error('No user found. Please connect your FreeStyle Libre App with LibreLinkUp');
          return;
        }
        this.deviceArray = [];
        for (const device of res.data.data) {
          const id = device.patientId; // Alternative datapoint for serial number

          this.deviceArray.push(id);
          const name = device.firstName + ' ' + device.lastName;

          await this.setObjectNotExistsAsync(id, {
            type: 'device',
            common: {
              name: name,
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.remote', {
            type: 'channel',
            common: {
              name: 'Remote Controls',
            },
            native: {},
          });
          await this.extendObjectAsync(id + '.general', {
            type: 'channel',
            common: {
              name: 'General Information. Update only once a day',
            },
            native: {},
          });
          // await this.setObjectNotExistsAsync(id + ".graphJson", {
          //   type: "state",
          //   common: {
          //     name: "Raw Graph JSON",
          //     write: false,
          //     read: true,
          //     type: "string",
          //     role: "json",
          //   },
          //   native: {},
          // });

          const remoteArray = [{ command: 'Refresh', name: 'True = Refresh' }];
          remoteArray.forEach((remote) => {
            this.setObjectNotExists(id + '.remote.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name || '',
                type: remote.type || 'boolean',
                role: remote.role || 'boolean',
                write: true,
                read: true,
              },
              native: {},
            });
          });
          this.json2iob.parse(id + '.general', device);
        }
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
          if (error.response.data && error.response.data.message && error.response.data.message === 'RequiredHeaderMissing') {
            this.log.error('Please update the version in the settings with the current version of the app');
          }
        }
      });
  }

  async updateDevices() {
    const statusArray = [
      {
        path: 'graph',
        url: 'https://api-' + this.config.region + '.libreview.io/llu/connections/$id/graph',
        desc: 'Graph data of the device',
      },
    ];

    for (const id of this.deviceArray) {
      for (const element of statusArray) {
        const url = element.url.replace('$id', id);

        await this.requestClient({
          method: element.method || 'get',
          url: url,
          headers: this.header,
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            let data = res.data;
            if (data.data) {
              data = data.data;
            }
            if (data.graphData) {
              data.graphData = data.graphData.reverse();
            }
            const forceIndex = true;
            const preferedArrayName = null;

            // this.setState(id + "." + element.path + "Json", JSON.stringify(data), true);
            this.json2iob.parse(id + '.' + element.path, data, {
              forceIndex: forceIndex,
              preferedArrayName: preferedArrayName,
              channelName: element.desc,
            });
          })
          .catch((error) => {
            if (error.response) {
              if (error.response.status === 401) {
                error.response && this.log.debug(JSON.stringify(error.response.data));
                this.log.info(element.path + ' receive 401 error. Refresh Token in 60 seconds');
                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                this.refreshTokenTimeout = setTimeout(() => {
                  this.refreshToken();
                }, 1000 * 60);

                return;
              }
            }
            this.log.error(url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      }
    }
  }
  async refreshToken() {
    if (!this.session) {
      this.log.error('No session found relogin');
      await this.login();
      return;
    }
    await this.login();
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      callback();
    } catch (e) {
      this.log.error(e);
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        //const deviceId = id.split('.')[2];
        const command = id.split('.')[4];
        if (id.split('.')[3] !== 'remote') {
          return;
        }

        if (command === 'Refresh') {
          this.updateDevices();
        }
      }
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Libre(options);
} else {
  // otherwise start the instance directly
  new Libre();
}
