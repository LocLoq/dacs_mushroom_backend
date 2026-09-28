import environment from './config/environment.cjs';
environment.loadEnvironment();

export default {
  datasource: {
    url: environment.getDatabaseUrl(),
  },
};

