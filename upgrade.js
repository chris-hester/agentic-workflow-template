#!/usr/bin/env node
// Upgrade an existing install to this template version. Same as
// `bootstrap.js --upgrade`; kept so older docs and habits keep working.

require('./lib/main').main([...process.argv.slice(2), '--upgrade']).catch(err => {
  console.error('\n❌ Upgrade failed: ' + err.message);
  process.exit(1);
});
