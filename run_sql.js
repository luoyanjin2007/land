// 通过 Supabase Management API 执行 SQL 的小工具
// 用法: node run_sql.js <sql文件路径>
const fs = require('fs');
const path = require('path');

const SUPABASE_REF = 'sqpkfvfnsbvgywwtpsjm';
// token 从环境变量读取，避免写死在代码里
const TOKEN = process.env.SUPABASE_PAT;

if (!TOKEN) {
  console.error('请先设置环境变量 SUPABASE_PAT（sbp_ 开头的个人访问令牌）');
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error('用法: node run_sql.js <sql文件路径>');
  process.exit(1);
}

const sql = fs.readFileSync(path.resolve(file), 'utf8');

fetch(`https://api.supabase.com/v1/projects/${SUPABASE_REF}/database/query`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: sql }),
}).then(async (r) => {
  console.log('HTTP:', r.status);
  console.log(await r.text());
});
