module.exports = {
  apps: [
    {
      name: 'zhidian',
      script: 'src/server.js',
      cwd: '/opt/zhidian-network',
      instances: 1,
      autorestart: true,
      env_file: '.env',
      error_file: '/data/logs/zhidian-error.log',
      out_file: '/data/logs/zhidian-out.log',
      merge_logs: true,
    },
  ],
};
