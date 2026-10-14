/**
 * PM2 process file for bhaiway-api.
 *
 * Usage (on VPS):
 *   pm2 start ecosystem.config.cjs
 *   pm2 reload bhaiway-api
 *
 * Log rotation (install once):
 *   pm2 install pm2-logrotate
 *   pm2 set pm2-logrotate:max_size 50M
 *   pm2 set pm2-logrotate:retain 14
 *   pm2 set pm2-logrotate:compress true
 *   pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
 *
 * Inspect:
 *   pm2 logs bhaiway-api --lines 200
 *   pm2 logs bhaiway-api --err
 *   jq -r . event=...  # if using structured JSON stdout
 *
 * Do not print secrets at startup. Do not delete historical logs from this file.
 */
module.exports = {
  apps: [
    {
      name: 'bhaiway-api',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      time: false,
      // Structured JSON goes to stdout; keep streams separate for ops.
      out_file: '/var/log/bhaiway/bhaiway-api.out.log',
      error_file: '/var/log/bhaiway/bhaiway-api.err.log',
      merge_logs: true,
      max_memory_restart: '750M',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
    },
  ],
};
