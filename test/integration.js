const assert = require('node:assert');
const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Starts a real js-controller, installs the adapter and checks it boots and shuts down
// cleanly. Runs with no display configured, which is the case that must not crash: the
// adapter should report the misconfiguration and stay alive so the user sees it in admin.
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('starts without a configured display', getHarness => {
            it('boots and stays alive with an empty host', async function () {
                this.timeout(60_000);
                const harness = getHarness();
                await harness.changeAdapterConfig('pro-bravia', { native: { host: '' } });
                await harness.startAdapterAndWait();
                assert.strictEqual(harness.isAdapterRunning(), true, 'adapter should still be running');
            });
        });
    },
});
