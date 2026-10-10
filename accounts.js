'use strict';
/* 账号列表 —— 写死在这个文件里，跟其他前端代码一样是公开可见的（不是真正的账户数据库）。
   改账号（加人、删人、改密码）：用页面里的"账号管理"面板生成新内容，下载这个文件，
   替换掉项目目录里的 accounts.js，再跑一次 deploy.command 发布。
   hash = sha256("username:password")。admin:true 的账号能打开账号管理面板和 Key 分享面板。 */
const ACCOUNTS = [
  { user: 'admin', hash: '253ad22d8bfc8a338e7d83d9075b13b92a0c7bd3e06ddb5243d7ca0c5fd4fea0', admin: true, label: 'Admin' },
];
