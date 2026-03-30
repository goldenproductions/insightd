const PREFIX = 'insightd';

function fmt(level, component, msg) {
  const ts = new Date().toISOString();
  return `${ts} [${PREFIX}] ${level} [${component}] ${msg}`;
}

const logger = {
  info: (component, msg) => console.log(fmt('INFO', component, msg)),
  warn: (component, msg) => console.warn(fmt('WARN', component, msg)),
  error: (component, msg, err) => {
    console.error(fmt('ERROR', component, msg));
    if (err) console.error(err.stack || err);
  },
};

module.exports = logger;
