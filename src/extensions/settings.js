"use strict";

const { registerMobileSettingsIpc } = require("../mobile-settings-ipc");

const BUILT_IN_SETTINGS_EXTENSIONS = [
  { registerSettingsIpc: registerMobileSettingsIpc },
];

function registerBuiltInSettingsExtensions(options, extensions = BUILT_IN_SETTINGS_EXTENSIONS) {
  for (const extension of extensions) {
    extension.registerSettingsIpc(options);
  }
}

module.exports = { registerBuiltInSettingsExtensions };
