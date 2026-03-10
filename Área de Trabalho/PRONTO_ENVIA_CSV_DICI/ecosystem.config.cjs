/**
 * PM2 Ecosystem Configuration
 * PRONTO_ENVIA_CSV_DICI - Anatel Coleta de Dados Automation
 *
 * Uso:
 *   pm2 start ecosystem.cjs.js
 *   pm2 status
 *   pm2 logs pronto-envia-csv
 *   pm2 stop pronto-envia-csv
 *   pm2 restart pronto-envia-csv
 *   pm2 delete pronto-envia-csv
 */

module.exports = {
  apps: [
    {
      name: 'pronto-envia-csv',
      script: './fluxo_completo_envio_mensal.js',
      args: '53202302000109 api/teste_53202302000109.csv 12/2025',
      instances: 1,
      autorestart: false,
      watch: false,
      max_memory_restart: '1G',
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Tratamento de erros
      exp_backoff_restart_delay: 100,
      // Limites de restart
      max_restarts: 3,
      min_uptime: '10s',
      // Variáveis de ambiente adicionais
      env_production: {
        NODE_ENV: 'production'
      },
      env_development: {
        NODE_ENV: 'development'
      }
    },
    {
      name: 'mqtt-fluxo-completo',
      script: './mqtt_subscriber_fluxo_completo.cjs',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        MQTT_BROKER: 'mqtt://195.200.1.71:1883',
        MQTT_TOPIC: 'auto/mensal/resultado'
      },
      error_file: './logs/mqtt-fluxo-completo-error.log',
      out_file: './logs/mqtt-fluxo-completo-out.log',
      log_file: './logs/mqtt-fluxo-completo-combined.log',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Tratamento de erros
      exp_backoff_restart_delay: 100,
      // Limites de restart
      max_restarts: 10,
      min_uptime: '10s'
    }
  ]
};
