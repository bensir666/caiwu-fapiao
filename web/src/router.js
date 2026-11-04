import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/login', name: 'login', component: () => import('./views/Login.vue'), meta: { public: true } },
  { path: '/', name: 'overview', component: () => import('./views/Overview.vue'), meta: { title: '欠票总览' } },
  { path: '/suppliers/:id', name: 'supplier', component: () => import('./views/SupplierDetail.vue'), props: true },
  { path: '/dunning', name: 'dunning', component: () => import('./views/Dunning.vue'), meta: { title: '催票清单' } },
  { path: '/statements', name: 'statements', component: () => import('./views/Statements.vue'), meta: { title: '对账单' } },
  { path: '/invoices', name: 'invoices', component: () => import('./views/Invoices.vue'), meta: { title: '发票' } },
  { path: '/tax-costs', name: 'taxcosts', component: () => import('./views/TaxCosts.vue'), meta: { title: '税费成本', fin: true } },
  { path: '/master', name: 'master', component: () => import('./views/Master.vue'), meta: { title: '基础资料', fin: true } },
  { path: '/users', name: 'users', component: () => import('./views/Users.vue'), meta: { title: '用户与设置', admin: true } },
  { path: '/audit', name: 'audit', component: () => import('./views/Audit.vue'), meta: { title: '操作记录', fin: true } },
  { path: '/password', name: 'password', component: () => import('./views/Password.vue'), meta: { title: '账号安全' } },
  { path: '/:p(.*)*', redirect: '/' },
];

const router = createRouter({ history: createWebHistory(), routes, scrollBehavior: () => ({ top: 0 }) });
export default router;
