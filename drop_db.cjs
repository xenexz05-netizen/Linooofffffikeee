const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://neondb_owner:npg_Lpnew20ZqGWI@ep-twilight-smoke-apib372v-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require' });
client.connect().then(() => client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')).then(() => { console.log('Dropped'); client.end(); }).catch(e => { console.error(e); process.exit(1); });
