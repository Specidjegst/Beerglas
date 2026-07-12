/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Wallet-Adapter / web3.js sind rein clientseitig — nichts Besonderes nötig,
  // aber wir pinnen ein sauberes Verhalten für optionale Node-Module.
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      os: false,
      path: false,
    };
    config.externals = [...(config.externals ?? []), "pino-pretty"];
    return config;
  },
};

export default nextConfig;
