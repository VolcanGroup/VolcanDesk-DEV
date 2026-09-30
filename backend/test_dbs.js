const { Sequelize } = require('sequelize');
const sequelize = new Sequelize('mysql://tickets_user:TktPass2026!@localhost:3306');
async function run() {
    try {
        const [results] = await sequelize.query('SHOW DATABASES;');
        console.log('DATABASES:', results.map(r => r.Database).join(', '));
    } catch (e) { console.error('DB_ERROR:', e.message); }
    process.exit();
}
run();
