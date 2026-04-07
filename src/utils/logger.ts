const PREFIX = 'insightd';

function fmt(level: string, component: string, msg: string): string {
  const ts = new Date().toISOString();
  return `${ts} [${PREFIX}] ${level} [${component}] ${msg}`;
}

const logger = {
  info: (component: string, msg: string) => console.log(fmt('INFO', component, msg)),
  warn: (component: string, msg: string) => console.warn(fmt('WARN', component, msg)),
  error: (component: string, msg: string, err?: unknown) => {
    console.error(fmt('ERROR', component, msg));
    if (err) console.error((err as Error).stack || err);
  },
};

export = logger;
