module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  extends: [
    'eslint:recommended',
    'plugin:prettier/recommended',
    'plugin:@typescript-eslint/recommended',
    'eslint-config-prettier',
  ],
  plugins: ['prettier', '@typescript-eslint'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module', // 添加此行
  },
  env: {
    node: true,
    es2021: true, // 或者 es2017, 取决于您使用的 ECMAScript 版本
  },
  rules: {
    // 在这里添加任何您需要覆盖的规则
  },
}
