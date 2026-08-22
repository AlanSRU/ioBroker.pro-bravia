const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Validates package.json and io-package.json against the ioBroker repository requirements.
tests.packageFiles(path.join(__dirname, '..'));
