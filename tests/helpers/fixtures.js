// Timestamps relative to now for consistent testing
const NOW = new Date();
const THIS_WEEK = new Date(NOW - 3 * 24 * 60 * 60 * 1000); // 3 days ago
const LAST_WEEK = new Date(NOW - 10 * 24 * 60 * 60 * 1000); // 10 days ago
const OLD = new Date(NOW - 40 * 24 * 60 * 60 * 1000); // 40 days ago

function ts(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Docker API responses
const DOCKER_CONTAINER_LIST = [
  { Names: ['/nginx'], Id: 'abc123def456789012', State: 'running', Image: 'nginx:alpine', Labels: {} },
  { Names: ['/redis'], Id: 'def456abc789012345', State: 'running', Image: 'redis:alpine', Labels: {} },
  { Names: ['/postgres'], Id: 'ghi789def012345678', State: 'running', Image: 'postgres:alpine', Labels: {} },
];

const DOCKER_CONTAINER_STOPPED = [
  { Names: ['/nginx'], Id: 'abc123def456789012', State: 'exited', Image: 'nginx:alpine', Labels: {} },
];

const DOCKER_INSPECT = { RestartCount: 3 };
const DOCKER_INSPECT_NO_RESTARTS = { RestartCount: 0 };

const DOCKER_STATS = {
  cpu_stats: {
    cpu_usage: { total_usage: 500000000 },
    system_cpu_usage: 10000000000,
    online_cpus: 2,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 400000000 },
    system_cpu_usage: 9000000000,
  },
  memory_stats: { usage: 104857600 }, // 100 MB
};

const DOCKER_STATS_SECOND = {
  cpu_stats: {
    cpu_usage: { total_usage: 600000000 },
    system_cpu_usage: 11000000000,
    online_cpus: 2,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 500000000 },
    system_cpu_usage: 10000000000,
  },
  memory_stats: { usage: 115343360 }, // 110 MB
};

const DOCKER_IMAGE_INSPECT = {
  RepoDigests: ['library/nginx@sha256:localdigest123'],
};

// Digest objects for template testing
const GREEN_DIGEST = {
  weekNumber: 14,
  generatedAt: NOW.toISOString(),
  overallStatus: 'green',
  summaryLine: 'No critical issues. Good week.',
  overallUptime: 100,
  totalRestarts: 0,
  restartedContainers: [],
  containers: [
    { name: 'nginx', uptimePercent: 100, restarts: 0, status: 'green' },
    { name: 'redis', uptimePercent: 100, restarts: 0, status: 'green' },
  ],
  trends: [],
  disk: [{ mount_point: '/', total_gb: 100, used_gb: 50, used_percent: 50 }],
  diskWarnings: [],
  updatesAvailable: [],
  endpoints: [],
};

const RED_DIGEST = {
  weekNumber: 14,
  generatedAt: NOW.toISOString(),
  overallStatus: 'red',
  summaryLine: '3 things need attention.',
  overallUptime: 85.5,
  totalRestarts: 5,
  restartedContainers: ['nginx', 'redis'],
  containers: [
    { name: 'nginx', uptimePercent: 75, restarts: 3, status: 'red' },
    { name: 'redis', uptimePercent: 96, restarts: 2, status: 'yellow' },
    { name: 'postgres', uptimePercent: 100, restarts: 0, status: 'green' },
  ],
  trends: [
    { name: 'postgres', cpuAvg: 15.2, ramAvgMb: 256, cpuChange: null, ramChange: 25, flagged: true },
  ],
  disk: [{ mount_point: '/', total_gb: 100, used_gb: 90, used_percent: 90 }],
  diskWarnings: [{ mount_point: '/', total_gb: 100, used_gb: 90, used_percent: 90 }],
  updatesAvailable: [{ container_name: 'nginx', image: 'nginx:alpine', has_update: 1 }],
  endpoints: [
    { name: 'My API', url: 'https://api.example.com', uptimePercent: 95.5, avgResponseMs: 120, totalChecks: 100 },
  ],
};

module.exports = {
  NOW, THIS_WEEK, LAST_WEEK, OLD, ts,
  DOCKER_CONTAINER_LIST, DOCKER_CONTAINER_STOPPED,
  DOCKER_INSPECT, DOCKER_INSPECT_NO_RESTARTS,
  DOCKER_STATS, DOCKER_STATS_SECOND,
  DOCKER_IMAGE_INSPECT,
  GREEN_DIGEST, RED_DIGEST,
};
