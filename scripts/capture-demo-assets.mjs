import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const assetRoot = path.join(root, 'docs', 'launch', 'demo-proof-assets');
const outDir = path.join(assetRoot, 'screenshots');
await fs.mkdir(outDir, { recursive: true });

const shots = [
  {
    id: '01-dashboard-attention-feed',
    tab: 'overview',
    title: 'Dashboard health and attention feed',
    caption: 'Fleet health starts with the one thing that needs attention: Jellyfin restart-spamming, backed by memory pressure and recent log context instead of a raw wall of charts.',
  },
  {
    id: '02-host-metrics',
    tab: 'hosts',
    title: 'Host metrics across Docker, k3s, and Proxmox',
    caption: 'The sample workspace mixes Docker, k3s, Proxmox VE, and HTTP endpoints so users can see host pressure and runtime status in one shared fleet view.',
  },
  {
    id: '03-diagnosis-log-evidence',
    tab: 'diagnosis',
    title: 'Container diagnosis with log evidence',
    caption: 'When a container is unhealthy, insightd ranks the likely cause, shows confidence, and keeps the exact log pattern and metric/restart/topology evidence beside the next action.',
  },
  {
    id: '04-alert-routes',
    tab: 'alerts',
    title: 'Alert routes and calm delivery',
    caption: 'Alerts are deduped, routed to Slack and ntfy, and suppressed when they match a known maintenance window so launch readers see calm notification behavior.',
  },
  {
    id: '05-endpoint-monitoring',
    tab: 'endpoints',
    title: 'Endpoint monitoring alongside infrastructure',
    caption: 'HTTP checks live beside infrastructure signals: p95 latency, TLS age, status, and alert-route delivery stay visible without leaving the homelab dashboard.',
  },
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
await page.goto('https://insightd.org/demo/', { waitUntil: 'networkidle' });
await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });

// Make screenshots stable and crop around the demo workspace card.
await page.addStyleTag({ content: `
  * { caret-color: transparent !important; }
  html { scroll-behavior: auto !important; }
  #demo-app { padding-top: 40px !important; padding-bottom: 48px !important; }
` });

const manifest = [];
for (const shot of shots) {
  await page.locator(`[data-demo-view="${shot.tab}"]`).click();
  await page.locator(`[data-demo-panel="${shot.tab}"]`).waitFor({ state: 'visible' });
  await page.locator('#demo-app').scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const file = `${shot.id}.png`;
  const screenshotPath = path.join(outDir, file);
  await page.locator('#demo-app > div').screenshot({ path: screenshotPath });
  const stat = await fs.stat(screenshotPath);
  manifest.push({ ...shot, file: `screenshots/${file}`, bytes: stat.size });
}

await browser.close();
await fs.writeFile(path.join(assetRoot, 'manifest.json'), JSON.stringify({ sourceUrl: 'https://insightd.org/demo/', capturedAt: new Date().toISOString(), viewport: '1440x1050', assets: manifest }, null, 2) + '\n');
console.log(JSON.stringify({ outDir, count: manifest.length, files: manifest.map(s => s.file) }, null, 2));
