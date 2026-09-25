#!/usr/bin/env node
// Install the agentic workflow into a new or existing project, or upgrade an
// existing install. Run from the project root: node <template>/bootstrap.js
// See --help for options.

require('./lib/main').main(process.argv.slice(2)).catch(err => {
  console.error('\n❌ ' + err.message);
  process.exit(1);
});
