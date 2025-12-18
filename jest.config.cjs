module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  transform: {
    '^.+\.js$': 'babel-jest',
  },
  testEnvironmentOptions: {
    NODE_OPTIONS: '--experimental-vm-modules',
  },
};
