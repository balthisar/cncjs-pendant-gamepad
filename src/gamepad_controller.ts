#!/usr/bin/env node

// actions
// A module that wraps the native extensions provided by `gamepad`, and converts
// the raw button presses into generic nouns using generic terminology.
//
// Copyright (c) 2017-2022 various contributors. See LICENSE for copyright
// and MIT license information.

import { Options }      from './console';
import { EventEmitter } from 'events';
import bindings         from 'bindings';
import log              from "npmlog";

//------------------------------------------------------------------------------
// Constant and interface definitions.
//------------------------------------------------------------------------------
const LOGPREFIX = 'GAMEPAD  '; // keep at 9 digits for consistency


//------------------------------------------------------------------------------
// Maps the button and axis values from the the gamepad library to an idealized
// description of the button/axis. This implementation might be fragile, in
// that we're attempting to map automatically based on the string provided by
// the library. The description for a bona fide PS5 controller is "Wireless
// Controller" for example. This will also serve as the default, which might
// offer some partial support to other controllers until they're added here.
// While this _could_ be loaded from a file, let's not bother with that
// complexity right now, as this API is a moving target.
//
// You can run this enclosing program in `-vvv` and `simulate` mode to
// consult the log output for mapping new controllers.
//------------------------------------------------------------------------------
const controllerMapping = {

  // This is the mapping for a Logitech F710 when it's in X mode. This is
  // supposedly the same as an Xbox controller, so it might be a good starting
  // point when we have a real one to test.
  'Logitech Gamepad F710': {
  
    'buttons': {
      '0':  'KEYCODE_BUTTON_A',
      '1':  'KEYCODE_BUTTON_B',
      '2':  'KEYCODE_BUTTON_X',
      '3':  'KEYCODE_BUTTON_Y',
      '4':  'KEYCODE_BUTTON_L1',
      '5':  'KEYCODE_BUTTON_R1',
      '6':  'KEYCODE_BACK',
      '7':  'KEYCODE_BUTTON_START',
      '8':  'KEYCODE_HOME',
      '9':  'KEYCODE_BUTTON_THUMBL',
      '10': 'KEYCODE_BUTTON_THUMBR'  
    },
    
    'axes': {
      '0': 'AXIS_X',
      '1': 'AXIS_Y',
      '2': 'AXIS_LTRIGGER',
      '3': 'AXIS_RZ',
      '4': 'AXIS_Z',
      '5': 'AXIS_RTRIGGER',
      '6': 'AXIS_HAT_X',
      '7': 'AXIS_HAT_Y'  
    }
  },

  // This is the mapping for a Logitech F710 when it's in D mode, which means
  // direct input. Note that some of its buttons don't activate in this mode.
  'Logitech Logitech Cordless RumblePad 2': {
  
    'buttons': {
      '0':  'KEYCODE_BUTTON_X',
      '1':  'KEYCODE_BUTTON_A',
      '2':  'KEYCODE_BUTTON_B',
      '3':  'KEYCODE_BUTTON_Y',
      '4':  'KEYCODE_BUTTON_L1',
      '5':  'KEYCODE_BUTTON_R1',
      '6':  'KEYCODE_BUTTON_LTRIGGER',
      '7':  'KEYCODE_BUTTON_RTRIGGER',
      '8':  'KEYCODE_BACK',
      '9':  'KEYCODE_BUTTON_START',
      '10': 'KEYCODE_BUTTON_THUMBL',
      '11': 'KEYCODE_BUTTON_THUMBR'
  },
    
    'axes': {
      '0': 'AXIS_X',
      '1': 'AXIS_Y',
      '2': 'AXIS_RZ',
      '3': 'AXIS_Z',
      '4': 'AXIS_HAT_X',
      '5': 'AXIS_HAT_Y'
      }
  },

  // This is the mapping for a SteelSeries Nimbus. It's missing a ridiculous
  // amount of buttons, and the D-pad doesn't work for some reason. Note that
  // this is an Apple-special model, and the mappings might be different on
  // macOS; all of this work was done on Debian.
  'Nimbus': {
  
    'buttons': {
      '0':  'KEYCODE_BUTTON_A',
      '1':  'KEYCODE_BUTTON_B',
      '2':  'KEYCODE_BUTTON_X',
      '3':  'KEYCODE_BUTTON_Y',
      '4':  'KEYCODE_BUTTON_L1',
      '5':  'KEYCODE_BUTTON_R1',
      '6':  'KEYCODE_BUTTON_LTRIGGER', 
      '7':  'KEYCODE_BUTTON_RTRIGGER'
      },
    
    'axes': {
      '0': 'AXIS_Y',
      '1': 'AXIS_X',
      '2': 'AXIS_Z',
      '3': 'AXIS_RZ'
      }
  },

  // This is a generic mapping, but it also represents a PS5 DualSense
  // controller. The controller reports "Wireless Controller", so it's what
  // we'll use when no others are detected.
  // Note that LT/RT on the PS5 triggers both an axis and a button press.
  // We could comment out one or the other, but this is our generic backup,
  // too, and we don't know what the entire other population of controllers
  // will send. If we were going to send gcode based on the triggers, then
  // we'd definitely want to choose one or the other. In this case, we're
  // going to use the triggers as a deadman switch, so it's okay if they
  // both send events.
  'Wireless Controller': {
  
    'buttons': {
      '0':  'KEYCODE_BUTTON_X',
      '1':  'KEYCODE_BUTTON_A',
      '2':  'KEYCODE_BUTTON_B',
      '3':  'KEYCODE_BUTTON_Y',
      '4':  'KEYCODE_BUTTON_L1',
      '5':  'KEYCODE_BUTTON_R1',
      '6':  'KEYCODE_BUTTON_LTRIGGER', // note: ALSO activates the axis.
      '7':  'KEYCODE_BUTTON_RTRIGGER', // note: ALSO activates the axis.
      '8':  'KEYCODE_BACK',
      '9':  'KEYCODE_BUTTON_START',
      '10': 'KEYCODE_BUTTON_THUMBL',
      '11': 'KEYCODE_BUTTON_THUMBR',
      '12': 'KEYCODE_HOME',
      '13': 'KEYCODE_BUTTON_TOUCHPAD'
      },
    
    'axes': {
      '0': 'AXIS_Y',
      '1': 'AXIS_X',
      '2': 'AXIS_Z',
      '3': 'AXIS_LTRIGGER', // note: also activates the button.
      '4': 'AXIS_RTRIGGER', // note: also activates the button.
      '5': 'AXIS_RZ',
      '6': 'AXIS_HAT_X',
      '7': 'AXIS_HAT_Y'
      }
  },
  '8Bitdo SN30 Pro': {
    'buttons': {
      '0': 'KEYCODE_BUTTON_A',        // A button
      '1': 'KEYCODE_BUTTON_B',        // B button
      '2': 'undefined',               // B button
      '3': 'KEYCODE_BUTTON_X',        /// Left bumper
      '4': 'KEYCODE_BUTTON_Y',        // Y button
      '6': 'KEYCODE_BUTTON_L1',       // Left bumper
      '7': 'KEYCODE_BUTTON_R1',       // Right bumper
      '8': 'KEYCODE_BUTTON_LTRIGGER', // Left trigger
      '9': 'KEYCODE_BUTTON_RTRGGER',  // Right trigger
      '10': 'KEYCODE_SELECT',         // Select button
      '11': 'KEYCODE_BUTTON_START',   // Start button
      '12': 'KEYCODE_HOME',           // Home button
      '13': 'KEYCODE_BUTTON_THUMBL',  // Left joystick button
      '14': 'KEYCODE_BUTTON_THUMBR'   // Right joystick button

    },

    'axes': {
      '0': 'AXIS_X',                 // Left joystick X-axis
      '1': 'AXIS_Y',                 // Left joystick Y-axis
      '2': 'AXIS_Z',                 // Right joystick X-axis
      '3': 'AXIS_RZ',                // Right joystick Y-axis
      '4': 'AXIS_RTRIGGER',
      '5': 'AXIS_LTRIGGER',
      '6': 'AXIS_HAT_X',             // D-pad horizontal
      '7': 'AXIS_HAT_Y'              // D-pad vertical
    }
  }
}


//------------------------------------------------------------------------------
// Represents the instantaneous state of the gamepad.
//------------------------------------------------------------------------------
export interface GamepadState {
  deviceID: string;
  description: string;
  vendorID: string;
  productID: string;
  axisStates: any;
  buttonStates: any;
};


//------------------------------------------------------------------------------
// Instances of this class receive events and event records when gamepad
// events occur. Consult the events you can subscribe to in the `on())`
// function.
//------------------------------------------------------------------------------
export class GamepadController {
    options: Options;
    mappings = [];
    connected = false;
    events = new EventEmitter.EventEmitter();
    gamepad = bindings('gamepad.node');;

    constructor(options: Options) {
        this.options = options;

        // finish setting up our native module
        this.gamepad.__proto__ = EventEmitter.EventEmitter.prototype;
        EventEmitter.EventEmitter.call(this.gamepad);
        this.gamepad.context.on = (...args) => {
          this.gamepad.emit.apply(this.gamepad, args);
        };

        // Listen for gamepad events
        this.gamepad.on('move', this.gamepadEventMove.bind(this));
        this.gamepad.on('up', this.gamepadEventUp.bind(this));
        this.gamepad.on('down', this.gamepadEventDown.bind(this));        
        this.gamepad.on('attach', this.gamepadEventAttach.bind(this));        
        this.gamepad.on('remove', this.gamepadEventRemove.bind(this));        
        
        // Create a gamepad loop and poll for events
        setInterval(this.gamepad.processEvents, 16);
        // Scan for new gamepads as a slower rate
        setInterval(this.gamepad.detectDevices, 500);
        // Initialize the library
        this.gamepad.init();
    }

    // subscribe to a gamepad event
    on(eventName: string, handler: any ) {
        switch (eventName) {
            case 'attach':
            case 'remove':
            case 'move':
            case 'press':
            case 'release':
            case 'use':
                break;
            default:
                log.error(LOGPREFIX, `GamepadController.on unknown event ${eventName}`);
                return;
        }
        this.events.on(eventName, handler);

        // if this is an attach event, and we already have a controller, let them know
        if (eventName == 'attach' && this.connected)
            this.events.emit('attach');
    }

    // unsubscribed from a gamepad event
    off(eventName: string, handler: any) {
        this.events.off(eventName, handler);
    }

    // determine if we have a valid gamepad connected
    isConnected() {
        return this.connected;
    }

    numDevices() {
        return this.gamepad.numDevices();
    }

    // PRIVATE METHODS

    // The `gamepad.deviceAtIndex()` is awlays 0-based, but controller ID's
    // keep incrementing when we connect and disconnect them. Thus, need to
    // find deviceAtIndex(n) where deviceID = id. I don't have an array o
    // of devices, though, so I have to query each one until I find it.
    deviceIndexForID(id: number) {
      for (let i = 0; i < this.gamepad.numDevices; i++) {
        if (this.gamepad.deviceAtIndex(i).deviceID == id)
          return i;
      }
      return undefined;
    }

    // Transform the generic structure provided by Gamepad.h into a hash with
    // meaningful keys. When an event occurs, it will be useful to know the
    // state of everything else, and not just the button being pressed.
    deviceStateForID(id: number): GamepadState {
      const gamepadIndex = this.deviceIndexForID(id);
      const gamepadRecord = this.gamepad.deviceAtIndex(gamepadIndex);

      if (gamepadRecord === undefined) {
        log.error(LOGPREFIX, 'deviceDataForID', `Device ${id} does not exist.`);
        return {} as GamepadState;
      }

      let result = {
        deviceID: gamepadRecord.deviceID,
        description: gamepadRecord.description,
        vendorID: gamepadRecord.vendorID,
        productID : gamepadRecord.productID,
        axisStates: {},
        buttonStates: {},
      } as GamepadState;

      for (let i = 0; i < gamepadRecord.axisStates.length; i++) {
        let buttonPress = this.mappings[id]?.axes[i];
        if (buttonPress)
          result.axisStates[buttonPress] = gamepadRecord.axisStates[i];
        else
          result.axisStates[i.toString()] = gamepadRecord.axisStates[i];
      }

      for (let i = 0; i < gamepadRecord.buttonStates.length; i++) {
        let buttonPress = this.mappings[id].buttons[i];
        if (buttonPress)
          result.buttonStates[buttonPress] = gamepadRecord.buttonStates[i];
        else
          result.buttonStates[i.toString()] = gamepadRecord.buttonStates[i];
      }

      return result;
    }
 
    gamepadEventAttach(id: number, state: GamepadState) {
      if (controllerMapping[state.description])
        this.mappings[id] = controllerMapping[state.description];
      else
        this.mappings[id] = controllerMapping['Wireless Controller'];

      this.connected = true;
      const deviceState = this.deviceStateForID(id);

      log.info(LOGPREFIX, `attach ${deviceState['description']} (id ${deviceState['deviceID']})`);

      this.events.emit('attach', id, deviceState);
    }

    gamepadEventRemove(id: number) {
      this.mappings[id] = {};
      this.connected = this.numDevices() > 0;

      log.info(LOGPREFIX, 'remove', `id ${id}`);

      this.events.emit('remove', id);
    }

    gamepadEventMove(id: number, axis: number, value: number) {
      const deviceState = this.deviceStateForID(id);
      const buttonPress = this.mappings[id].axes[axis];
      log.trace(LOGPREFIX, 'move', {
        id: id,
        axis: axis,
        value: value,
        button: buttonPress
      });
      if (buttonPress) {
        this.events.emit('move', buttonPress, value, deviceState);
        this.events.emit('use', buttonPress, deviceState);
      }
    }
    
    gamepadEventDown(id: number, num: number) {
      const deviceState = this.deviceStateForID(id);
      const buttonPress = this.mappings[id].buttons[num];
      log.trace(LOGPREFIX, 'press', {
        id: id,
        num: num,
        button: buttonPress
      });
      if (buttonPress) {
        this.events.emit('press', buttonPress, deviceState);
        this.events.emit('use', buttonPress, deviceState);
      }
    }

    gamepadEventUp(id: number, num: number) {
      const deviceState = this.deviceStateForID(id);
      const buttonPress = this.mappings[id].buttons[num];
      log.trace(LOGPREFIX, 'release', {
        id: id,
        num: num,
        button: buttonPress
      });
      if (buttonPress) {
        this.events.emit('release', buttonPress, deviceState);
        this.events.emit('use', buttonPress, deviceState);
      }
    }
}
