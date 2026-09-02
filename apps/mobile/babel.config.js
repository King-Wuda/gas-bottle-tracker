module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // react-native-worklets/plugin must be LAST. Powers react-native-reanimated
    // (an expo-router peer). Without it `expo start` throws at bundle time.
    plugins: ['react-native-worklets/plugin'],
  };
};
