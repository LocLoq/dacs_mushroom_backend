import { loadEnvFile } from 'process';
loadEnvFile();

export default {
  datasource: {
    url: process.env.DATABASE_URL,
  },
};

