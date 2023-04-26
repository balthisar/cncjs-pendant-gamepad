#!/usr/bin/env node

// console
// A module that provides a command line interface to this package. It starts
// all services such as the connector, gamepad controller, log system, etc.
//
// Copyright (c) 2017-2022 various contributors. See LICENSE for copyright
// and MIT license information.

import { program, Option, Argument, Command } from 'commander';
import { createRequire }                      from 'module';
import { GamepadController }                  from './gamepad_controller.js';
import { Connector }                          from './connector.js';
import { Actions }                            from "./actions.js";
import { ActionsMappings }                    from "./actions.js";

// These weird (old-fashioned?) imports are inherently singletons, and we're
// not interested in eventually testing them anyway, so let's just use them
// as singletons without any dependency injectability.
import fs from 'fs';
import log from 'npmlog';
import os from 'os';
import path from 'path';
import process from 'process'; 
import merge from 'deepmerge';

//----------------------------------------------------------------------------
// Constant definitions.
//----------------------------------------------------------------------------
const LOGPREFIX = 'CLI      '; // keep at 9 digits for consistency

//----------------------------------------------------------------------------
// Interface definitions.
//----------------------------------------------------------------------------

// An interface describing program options.
export interface Options {
  accessTokenLifetime: string;
  baudrate: string;
  controllerType: string;
  port: string;
  secret: string;
  simulate: boolean;
  socketAddress: string;
  socketPort: string;
  verbose: number;
  zProbeThickness: string;
  actionsMap: ActionsMappings;
};

//----------------------------------------------------------------------------
// Execute the command line program.
//----------------------------------------------------------------------------
export function startCLI() {

  const version = programVersion();
  const optVersion = 'options_version_2.0';

  const cliOptions : Options = configureCLI(program, version)
    .parse()
    .opts();
  cliOptions['simulate'] = (program.args[0] === 'simulate');
  cliOptions['actionsMap'] = {};

  const options : Options = mergeOptions(cliOptions, getFileOptions(optVersion))

  configureLogging(options);

  console.log(`${program.name()} is currently running. Stop running with Control-C`);
  console.log(`Use '${program.name()} --help' if you're expecting to see something else here.`);

  log.trace(LOGPREFIX, 'Creating the GamepadController instance.');
  const gamepadController = new GamepadController(options);

  log.trace(LOGPREFIX, 'Starting the main connector service.');
  const connector = new Connector(gamepadController, options);

  log.trace(LOGPREFIX, 'Starting the actions service.');
  new Actions(connector, options);
}


//----------------------------------------------------------------------------
// configureCLI()
// Use command to set up a reasonable CLI to the services. Note that we're
// selecting 'run' or 'simulate' via an argument rather than differing
// 'commands' because there's no default command provision, and commands
// aren't able to share all of the options. This is a Commander limitation.
// TODO: re-add the 'smoothie' and 'tinyg' options. “Need help!”
//----------------------------------------------------------------------------
function configureCLI(cli: Command, version: string) {
  cli
    .showHelpAfterError()
    .version(version)
    .name('cncjs-pendant-gamepad')
    .description('Use a supported game controller as a pendant to control CNCjs.')
    .usage('[options] [run|simulate]')

    .option('-p, --port <port>',                          'serial port path of cnc machine',                        '/dev/ttyUSB0')
    .option('-b, --baudrate <baudrate>',                  'baud rate of serial port or cnc machine',                '115200')

    .addOption(new Option('-t, --controller-type <type>', 'controller type')
      .choices(['Grbl', 'marlin'])
      .default('Grbl'))

    .option('-s, --secret <secret>',                      'the secret key stored in the ~/.cncrc file')
    .option('--socket-address <address>',                 'cncjs address or hostname',                              'localhost')
    .option('--socket-port <port>',                       'cncjs port',                                             '8000')
    .option('--access-token-lifetime <lifetime>',         'access token lifetime in seconds or a time span string', '30d')
    .option('-v, --verbose',                              'display verbose messages; use multiple times to increase verbosity', function(v,a) {return a+1;}, 0)
    .option('-z, --z-probe-thickness <mm>',               'thickess of the touch plate used for z-axis probing',    '20')

    .addArgument(new Argument('[action]', 'what to do').choices(['run', 'simulate']).default('run'))
  return cli;
}


//--------------------------------------------------------------------------
// Get a Javascript object from the given JSON file.
//--------------------------------------------------------------------------
function loadOptionsFile(filename: any, optionsVersion : string) : Options {
  try {
    const rawData = fs.readFileSync(filename, "utf8");
    const result = JSON.parse(rawData)[optionsVersion];
    return result || {} as Options;
  } catch (err) {
    log.warn(LOGPREFIX, err);
    return {} as Options;
  }
}

//--------------------------------------------------------------------------
// Loads options from multiple sources (if available), and merges them
// into a single representation. Note that Windows doesn't have anything
// like /etc, and macOS should follow the the Unix convention for CLI
// applications and use ~/, *not* ~/Library/Application Support/.
//--------------------------------------------------------------------------
function getFileOptions(optionsVersion : string) : Options {
  if (os.platform() == 'win32') {
    const userOpts = loadOptionsFile(path.resolve(os.homedir(), '.cncjs-pendant-gamepad.rc.json'), optionsVersion);
    const dfltOpts = loadOptionsFile(new URL('cncjs-pendant-gamepad.rc.json', import.meta.url), optionsVersion)
    const result = merge.all([dfltOpts, userOpts]);
    return result as Options;
  } else {
    const dfltOpts = loadOptionsFile(new URL('cncjs-pendant-gamepad.rc.json', import.meta.url), optionsVersion)
    const systOpts = loadOptionsFile(path.resolve('/', 'etc', 'cncjs-pendant-gamepad.rc.json'), optionsVersion);
    const userOpts = loadOptionsFile(path.resolve(os.homedir(), '.cncjs-pendant-gamepad.rc.json'), optionsVersion);
    const result = merge.all([dfltOpts, systOpts, userOpts]);
    return result as Options;
    }
}


//----------------------------------------------------------------------------
// Merge file file options into commander's options. The shallow merge
// doesn't work because we need to know whether an option from Commander
// was specified on the command line or not for it to take precedence.
//----------------------------------------------------------------------------
function mergeOptions(cliOptions : Options, fileOptions : Options) : Options {

  // Determine which option value to use in the program.
  function winningValue(optionName : string) : any {
    if (program.getOptionValueSource(optionName) === 'cli') {
      return cliOptions[optionName];
    }
    return fileOptions[optionName] || cliOptions[optionName];
  }

  const result = {
    "accessTokenLifetime": winningValue('accessTokenLifetime'),
    "baudrate": winningValue('baudrate'),
    "controllerType": winningValue('controllerType'),
    "port": winningValue('port'),
    "secret": winningValue('secret'),
    "simulate": cliOptions['simulate'],
    "socketAddress": winningValue('socketAddress'),
    "socketPort": winningValue('socketPort'),
    "verbose": winningValue('verbose'),
    "zProbeThickness": winningValue('zProbeThickness'),
    "actionsMap": fileOptions['actionsMap']  
  }
  return result;
}

//----------------------------------------------------------------------------
// configureLogging()
//----------------------------------------------------------------------------
function configureLogging(options: Options) {
  log.stream = process.stdout;
  log.levels = {};
  log.heading = "CNCpad";
  log.headingStyle = { fg: 'grey' }

  log.addLevel('trace', -Infinity, { fg: 'brightCyan' }, 'trace'); // -vvv
  log.addLevel('debug', 1000,      { fg: 'cyan' },       'debug'); // -vv
  log.addLevel('info',  2000,      { fg: 'green' },      ' info'); // -v
  log.addLevel('warn',  3000,      { fg: 'yellow' },     ' warn'); 
  log.addLevel('error', 4000,      { fg: 'brightRed' },  'error');
  log.addLevel('silent', Infinity);

  switch (options.verbose) {
    case 0:
      log.level = 'warn';
      break;
    case 1:
      log.level = 'info';
      break;
    case 2:
      log.level = 'debug';
      break;
    default:
      log.level = 'trace';
  }
}


//----------------------------------------------------------------------------
// demoLogging()
// A simple demonstration of what can/will be output from the logging system.
//----------------------------------------------------------------------------
function demoLogging() {
  log.trace('DRIVER   ', 'registers: pc=0402 sr=30 ac=00 xr=0 yr=0 sp=f7');
  log.debug('DRIVER   ', 'KEYCODE_BUTTON_L1: true');                        
  log.info('','Waiting for a gamepad to be connected.');                  
  log.warn('FRONTEND ', 'Password is weak.');
  log.error('CONNECTOR', 'Short circuit detected in operator.');
  log.silent('','You should never see this.');
}


//----------------------------------------------------------------------------
// ESM import doesn't allow JSON, and the old `require` doesn't work unless
// we re-enable it manually. Now we can bring in our package.json file.
//----------------------------------------------------------------------------
function programVersion(): string {
  const oldRequire = createRequire(import.meta.url);
  const pkg = oldRequire('../package.json');
  return pkg.version;
}
