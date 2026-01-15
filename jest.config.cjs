module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  transform: {
    '^.+\.js$': 'babel-jest',
  },
  coverageProvider: 'v8',
  testEnvironmentOptions: {
    NODE_OPTIONS: '--experimental-vm-modules',
  },
};
