#!/usr/bin/env node

// connector
// A module that connects to a CNCjs instance via websockets, and maintains
// a virtual serial connection via that socket to a connected CNC machine.
//
// Copyright (c) 2017-2022 various contributors. See LICENSE for copyright
// and MIT license information.

import { GamepadController }  from './gamepad_controller.js';
import { Options }            from './console';
import { clearInterval }      from 'timers';
import * as fs                from 'fs';
import * as path              from 'path';
import jwt                    from 'jsonwebtoken'; 
import log                    from "npmlog";

// Note: don't be tempted to update package.json to the newest version of
// this; its version must match the version in use by CNCjs, which is 2.x.
import io                     from 'socket.io-client';


//------------------------------------------------------------------------------
// Constant and interface definitions.
//------------------------------------------------------------------------------
const LOGPREFIX = 'CONNECTOR'; // keep at 9 digits for consistency


//----------------------------------------------------------------------------
// This class maintains connections to the local instance of CNCjs via its
// socket connection, as well as to the serial port in use by CNCjs. Once set
// up, we're just waiting for events to cause our other methods to fire.
// Essentially, what's going to happen is this:
// - If there are no controllers connected, then wait for one to connect.
// - Upon connecting at least one controller, establish socket.
// - Upon losing all controllers, disconnect socket, stop everything that
//   can be stopped, then wait for a connection again.
// - When a controller is connected, it will signal callbacks.
//----------------------------------------------------------------------------
export class Connector {
  gamepadController: GamepadController;
  serialConnected = false;
  options: Options;
  socket: io.Socket;
  serial: NodeJS.Timer;
  logPrefix: string;
  awaitingString = 'Waiting for a game controller to be connected.';
  
  constructor(gamepadController: GamepadController, options: Options) {
    this.gamepadController = gamepadController;
    this.options = options;
    this.logPrefix = options.simulate ? 'SIMULATOR' : LOGPREFIX;

    if (!gamepadController.isConnected())
      log.info(this.logPrefix, this.awaitingString);

    // When a device is connected and a socket is not already opened, then
    // open a new socket to the host, and connect to the serial port. If
    // there are multiple controllers, announce this fact!
    // Note: we're deliberitely choosing to open a socket and serial
    //   connection only while a controller is connected. There's no reason
    //   to keep a socket and serial connection open needlessly, but also it
    //   enables us to unplug and plug in the gamepad in order to kick off
    //   reconnection attempts. Ironically, "unplug the joystick and plug it in
    //   again" will be valid troubleshooting, but not for reasons end users
    //   might expect ;-)
    gamepadController.on('attach', (id, state) => {
      const numDevices = gamepadController.numDevices();
      if (numDevices == 1) 
        this.connectServer();
      else 
        log.warn(this.logPrefix, `There are ${numDevices} game controllers attached. Operate with caution!`);
    });


    // When the last game controller is disconnected, then close the socket and
    // serial connections, and then display the waiting message.
    gamepadController.on('remove', (id, state) => {
      const numDevices = gamepadController.numDevices();
      if (numDevices < 1 && this.socket) {
        this.socket.destroy();
        clearInterval(this.serial);
        this.serialConnected = false;
      }

      log.info(this.logPrefix, this.awaitingString);
    });

  } // constructor()


  //--------------------------------------------------------------------------
  // Start socket connection and controller connection.
  //--------------------------------------------------------------------------
  connectServer() {
    // We'll do this every time we connect to the server, because the sources
    // of the secret may have changed between executions.
    if (!this.options.secret)
      this.updateSecrets();

    // Set up access to the cnc.js socket server, with a valid access token.
    const token = this.generateAccessToken({ id: '', name: 'cncjs-pendant' }, this.options.secret, this.options.accessTokenLifetime);
    const server = `ws://${this.options.socketAddress}:${this.options.socketPort}`;

    // Attempt to connect to the server. By default, `io.connect` will keep
    // trying forever and ever, so we will only sit back and let it.
    log.info(this.logPrefix, `Attempting connect to ${server}`);
    if (this.options.simulate)
      this.openSerial();
    else
      this.socket = io.connect(server, { 'query': `token=${token}` });


    //------------------------------------------------------------------------
    // cncjs sent us a 'connect' message, saying that we are successfully
    // communicating via the socket. Cascade this success into next steps.
    //------------------------------------------------------------------------
    this.subscribeMessage('connect', () => {
      log.info(this.logPrefix, `Connected to ${server}`);
      this.openSerial();
    });

    //------------------------------------------------------------------------
    // cncjs sent us an 'error' message. Not much we can do but report it and
    // kill our connection.
    //------------------------------------------------------------------------
    this.subscribeMessage('error', (err) => {
      log.error(this.logPrefix, 'Error message received from cncjs - killing connection');
      if (this.socket) 
        this.socket.destroy();
      log.info(this.logPrefix, `Attempting reconnect to ${server}`);
      this.socket = io.connect(server, { 'query': `token=${token}` });
    });

    //------------------------------------------------------------------------
    // Socket connection closed message received.
    //------------------------------------------------------------------------
    this.subscribeMessage('close', () => {
      log.info(this.logPrefix, `CNCjs closed connection to ${server}.`);
      log.info(this.logPrefix, `Attempting reconnect to ${server}`);
      this.socket = io.connect(server, { 'query': `token=${token}` });
    });

    //------------------------------------------------------------------------
    // Our serial port open request has completed.
    //------------------------------------------------------------------------
    this.subscribeMessage('serialport:open', () => {
      clearInterval(this.serial);
      this.serialConnected = true;
      this.serial = null;
      log.info(this.logPrefix, `Connection to ${this.options.port} successful.`);
    });

    //------------------------------------------------------------------------
    // The server has closed the serial port.
    //------------------------------------------------------------------------
    this.subscribeMessage('serialport:close', () => {
      this.serialConnected = false;
      log.info(this.logPrefix, `Connection closed to ${this.options.port}.`);
      this.openSerial();
    });

    //------------------------------------------------------------------------
    // We got an error attempting to open the serial port
    //------------------------------------------------------------------------
    this.subscribeMessage('serialport:error', () => {
      this.serialConnected = false;
      log.error(this.logPrefix, `Error opening serial port ${this.options.port}`);
      this.openSerial();
    });

    //------------------------------------------------------------------------
    // Something was read from the serial port.
    //------------------------------------------------------------------------
    this.subscribeMessage('serialport:read', (data: string) => {
      log.trace(this.logPrefix, `Read from serial port: ${data}`);
    });

    //------------------------------------------------------------------------
    // Something was written to the serial port.
    //------------------------------------------------------------------------
    this.subscribeMessage('serialport:write', (data: string) => {
      log.trace(this.logPrefix, `Write to serial port: ${data}`);
    });

    //------------------------------------------------------------------------
    // Gives us the controller parameters.
    // This could be used to get $130, $131, $132 which give use the maximum
    // travel distances for each axis. Except:
    //   - I can only test with grbl, so I wouldn't have these for other
    //     controllers, and
    //   - Any time you connect to the machine, the mpos is reset to {0} until
    //     after homing.
    // This would have been a nice way to implement our own soft limits for
    // the joystick. Anyway, let's keep this around for the future.
    //------------------------------------------------------------------------
    this.subscribeMessage('controller:settings', (type: string, settings: any) => {
      log.trace(this.logPrefix, `controller:settings for ${type}`, settings);
    });

    //------------------------------------------------------------------------
    // Current machine status.
    // Would have been nice to know where we are before making a jog request,
    // but unless homing, we have no idea where we are. The mpos resets to
    // {0} whenever we connect to the serial port. Grbl doesn't remember. 
    //------------------------------------------------------------------------
    this.subscribeMessage('controller:state', (type: string, state: any) => {
      log.trace(this.logPrefix, `controller:state for ${type}`, state);
    });
      
    //------------------------------------------------------------------------
    // Returns the state of the current workflow.
    //   WORKFLOW_STATE_IDLE = idle
    //   WORKFLOW_STATE_PAUSED = paused
    //   WORKFLOW_STATE_RUNNING = running
    // We should ignore inputs when not idle.
    //------------------------------------------------------------------------
    this.subscribeMessage('workflow:state', (state: any) => {
      log.trace(this.logPrefix, 'workflow:state', state);
    });

  } // connectServer()


  //--------------------------------------------------------------------------
  // Generate a token for use in connecting securely to the CNCjs socket.
  //--------------------------------------------------------------------------
  generateAccessToken (payload: any, secret: string, expiration: string): string {
    const {sign} = jwt;
    const token = sign(payload, secret, { expiresIn: expiration });
    return token;
  };


  //--------------------------------------------------------------------------
  // Send a message to CNCjs requesting to open the serial port.
  // `this.socket.emit()` is just a request. If the server isn't connected,
  // then we'll never connect, and there's no mechanism for the server
  // to announce to us that it is ready. Thus, just keep spamming on
  // it until someone answers.
  //--------------------------------------------------------------------------
  openSerial() {
    const msg = `Sending open request for ${this.options.port} at baud rate ${this.options.baudrate}`;
    if (this.options.simulate) {
      log.info(this.logPrefix, msg);
      log.info(this.logPrefix, `Connection to ${this.options.port} successful.`);
    } else {
      if (!this.serial && !this.serialConnected) {
        this.serial = setInterval(() => {
          log.info(this.logPrefix, msg);
          this.socket.emit('open', this.options.port, {
            baudrate: Number(this.options.baudrate),
            controllerType: this.options.controllerType
          });
        }, 2000);
      }
    }
  };


  //--------------------------------------------------------------------------
  // Handle receiving messages from cncjs socket server, or faking
  // out for `--fake-socket` option.
  //--------------------------------------------------------------------------
  subscribeMessage(msg: string, callback: any) {
    if (!this.options.simulate) {
      if (this.socket) {
        this.socket.on(msg, callback);
        log.info(this.logPrefix, `Ready to listen for message '${msg}' from the socket.`);
      } else {
        log.warn(this.logPrefix, `Socket is not connected. Unable to subscribe to message '${msg}'.`);
      }
    }
  };


  //--------------------------------------------------------------------------
  // Update the stored secret if not set. This can be called each time
  // a connection is made in order to account for external changes.
  //--------------------------------------------------------------------------
  updateSecrets() {
    const userHome = process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'];
    const cncrc = path.resolve(userHome || '', '.cncrc');
    try {
      const config = JSON.parse(fs.readFileSync(cncrc, 'utf8'));
      this.options.secret = config.secret;
    } catch (err) {
      log.error(this.logPrefix, err);
      process.exit(1);
    }
  };

} // class Connector 
