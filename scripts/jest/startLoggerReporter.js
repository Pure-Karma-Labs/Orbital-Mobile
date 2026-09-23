'use strict';

/**
 * Jest reporter that prints a START line for every test file as it begins.
 *
 * Registered in jest.config.js reporters only when process.env.CI is set, so
 * local output stays quiet.  When the Jest step cap fires in CI, the last
 * "▶ START" line without a matching PASS names the hung suite (#834).
 *
 * Usage (jest.config.js):
 *   reporters: [
 *     'default',
 *     ...(process.env.CI ? ['./scripts/jest/startLoggerReporter'] : []),
 *   ],
 */
class StartLoggerReporter {
  onTestStart(test) {
    // test.path is the absolute path; strip the project root for readability.
    const cwd = process.cwd();
    const rel = test.path.startsWith(cwd + '/')
      ? test.path.slice(cwd.length + 1)
      : test.path;
    process.stdout.write(`▶ START ${rel}\n`);
  }
}

module.exports = StartLoggerReporter;
