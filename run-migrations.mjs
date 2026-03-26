import pg from 'pg';
import { readFileSync } from 'fs';

// Try multiple connection approaches
const configs = [
  {
    label: 'Transaction pooler (port 6543)',
    connectionString: 'postgresql://postgres.pmsmvpixvajpvrmeckgr:REDACTED_SUPABASE_SECRET@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres',
  },
  {
    label: 'Session pooler (port 5432)',
    connectionString: 'postgresql://postgres.pmsmvpixvajpvrmeckgr:REDACTED_SUPABASE_SECRET@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
  },
  {
    label: 'Direct (port 5432)',
    connectionString: 'postgresql://postgres:REDACTED_SUPABASE_SECRET@db.pmsmvpixvajpvrmeckgr.supabase.co:5432/postgres',
  },
  {
    label: 'Region 1 pooler',
    connectionString: 'postgresql://postgres.pmsmvpixvajpvrmeckgr:REDACTED_SUPABASE_SECRET@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres',
  },
];

for (const config of configs) {
  console.log(`\nTrying: ${config.label}...`);
  const client = new pg.Client({ 
    connectionString: config.connectionString, 
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  
  try {
    await client.connect();
    console.log('  Connected!');
    
    // Run migrations
    const sql001 = readFileSync('migrations/001_initial_schema.sql', 'utf-8');
    console.log('  Running 001_initial_schema.sql...');
    await client.query(sql001);
    console.log('  ✓ Tables created');

    const sql002 = readFileSync('migrations/002_search_functions.sql', 'utf-8');
    console.log('  Running 002_search_functions.sql...');
    await client.query(sql002);
    console.log('  ✓ Search functions created');

    // Verify
    const { rows: tables } = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name LIKE 'memory_%'
      ORDER BY table_name
    `);
    console.log('\n  Tables:');
    tables.forEach(t => console.log(`    - ${t.table_name}`));

    const { rows: funcs } = await client.query(`
      SELECT routine_name FROM information_schema.routines
      WHERE routine_schema = 'public' AND routine_name LIKE 'match_%'
      ORDER BY routine_name
    `);
    console.log('\n  Functions:');
    funcs.forEach(f => console.log(`    - ${f.routine_name}`));

    console.log('\n✅ All migrations completed!');
    await client.end();
    process.exit(0);
  } catch (err) {
    console.log(`  Failed: ${err.message}`);
    try { await client.end(); } catch {}
  }
}

console.log('\n❌ All connection methods failed');
process.exit(1);
