'use strict';
/* 账号列表 —— 写死在这个文件里，跟其他前端代码一样是公开可见的（不是真正的账户数据库）。
   改账号（加人、删人、改密码）：用页面里的"账号管理"面板生成新内容，下载这个文件，
   替换掉项目目录里的 accounts.js，再跑一次 deploy.command 发布。
   hash = sha256("username:password")。admin:true 的账号能打开账号管理面板和 Key 分享面板。 */
const ACCOUNTS = [
  { user: 'admin', hash: '6fd1e4aebb6b1f1937d1ccf90432c394c4fc0dc3d555178041bb34ebf654835e', admin: true, label: 'Admin' },
];
