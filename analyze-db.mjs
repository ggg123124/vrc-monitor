/**
 * VRCX-0 数据库结构分析 v2
 * 用法: node analyze-db.mjs [VRCX数据库路径]
 * 默认路径按平台自动探测（Windows VRCX-0 默认安装位置）
 * 引擎: better-sqlite3（只读打开，与 migrate-vrcx0.mjs 同步迁移，移除 sql.js）
 */
import Database from 'better-sqlite3';

const DB_PATH = process.argv[2] || 'C:/Users/<用户名>/AppData/Roaming/VRCX-0/VRCX-0.sqlite3';

async function main() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const tableNames = tables.map(r => r.name);

  console.log('══════════════════════════════════════════════');
  console.log('  VRCX-0 数据库结构分析');
  console.log(`  路径: ${DB_PATH}`);
  console.log(`  总表数: ${tableNames.length}`);
  console.log('══════════════════════════════════════════════\n');

  // 全局表
  console.log('━ 全局表 ｜━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  for (const name of tableNames) {
    if (name.startsWith('usr') || name.startsWith('_usr')) continue;
    printTableInfo(db, name);
  }

  // 用户数据表
  const userTables = tableNames.filter(n => n.startsWith('usr') || n.startsWith('_usr'));
  const prefixSet = new Set();
  for (const n of userTables) {
    const m = n.match(/^(.*?)_(feed|moderation|notes|notifications|friend_log|mutual_graph|activity|avatar_history)/);
    if (m) prefixSet.add(m[1]);
  }
  const prefixes = [...prefixSet].sort();

  console.log(`\n━ 用户数据表 ｜━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  用户前缀数: ${prefixes.length}\n`);

  for (const prefix of prefixes) {
    const prefixTables = tableNames.filter(n => n.startsWith(prefix + '_'));
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM "${prefixTables[0]}"`).get();
    const hasData = countRow.c > 0;
    console.log(`  ▸ ${prefix}  (${prefixTables.length} 张表, ${hasData ? '有数据' : '空'})`);
    if (hasData) {
      for (const name of prefixTables) {
        printTableInfo(db, name);
      }
    }
  }

  // 数据量统计
  console.log('\n━ 数据量统计 ｜━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  for (const name of tableNames) {
    try {
      const { c } = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get();
      if (c > 0) {
        console.log(`  ${name.padEnd(50)} : ${c} 行`);
      }
    } catch {}
  }

  db.close();
}

function printTableInfo(db, name) {
  let cols, rows;
  try {
    cols = db.prepare(`PRAGMA table_info("${name}")`).all();
    rows = db.prepare(`SELECT * FROM "${name}" LIMIT 2`).all();
  } catch (e) {
    console.log(`  ┌─ ${name}`);
    console.log(`  │  (error: ${e.message})`);
    console.log('  └─');
    return;
  }

  const colDefs = cols.map(c => {
    const flags = [];
    if (c.pk) flags.push('PK');
    if (c.notnull) flags.push('NN');
    return { colName: c.name, colType: c.type, flags, defaultVal: c.dflt_value };
  });

  console.log(`  ┌─ ${name}  (${colDefs.length} 字段)`);
  // 列
  const colLines = colDefs.map(c => {
    let s = `  │    ${c.colName}`;
    if (c.colType) s += `  ${c.colType}`;
    if (c.flags.length) s += `  [${c.flags.join(',')}]`;
    if (c.defaultVal) s += `  =${c.defaultVal}`;
    return s;
  });
  console.log(colLines.join('\n'));

  // 示例
  if (rows.length > 0) {
    console.log('  │  ── 示例数据 ──');
    for (const row of rows) {
      const pairs = Object.entries(row).map(([col, val]) => {
        if (val === null || val === undefined) return `${col}=null`;
        let s = String(val);
        if (s.length > 80) s = s.slice(0, 80) + '…';
        // 如果是JSON对象，格式化
        if (s.startsWith('{') || s.startsWith('[')) {
          try {
            s = JSON.stringify(JSON.parse(s)).slice(0, 80) + '…';
          } catch {}
        }
        return `${col}=${s}`;
      }).join(', ');
      console.log(`  │  > ${pairs}`);
    }
  } else {
    console.log('  │  (空)');
  }
  console.log('  └─');
}

main().catch(e => console.error('异常:', e));
