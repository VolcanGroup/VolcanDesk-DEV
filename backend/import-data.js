const fs = require('fs');
const { sequelize, Group, Company, User, CampoCatalogo, ReglaFlujo, Config, Ticket, Comment, TicketCampoValor, TicketBloqueoHistorial, AreaAccesoExtra } = require('./db.js');

async function importData() {
    console.log('Iniciando importación...');
    const data = JSON.parse(fs.readFileSync('./data-export.json', 'utf8'));
    
    await sequelize.authenticate();
    
    // Disable foreign key checks for import
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    
    try {
        if (data.groups) { console.log('Groups:', data.groups.length); await Group.bulkCreate(data.groups, { ignoreDuplicates: true }); }
        if (data.companies) { console.log('Companies:', data.companies.length); await Company.bulkCreate(data.companies, { ignoreDuplicates: true }); }
        if (data.users) { console.log('Users:', data.users.length); await User.bulkCreate(data.users, { ignoreDuplicates: true }); }
        if (data.camposCatalogo) { console.log('CamposCatalogo:', data.camposCatalogo.length); await CampoCatalogo.bulkCreate(data.camposCatalogo, { ignoreDuplicates: true }); }
        if (data.reglasFlujo) { console.log('ReglasFlujo:', data.reglasFlujo.length); await ReglaFlujo.bulkCreate(data.reglasFlujo, { ignoreDuplicates: true }); }
        
        if (data.config) {
            console.log('Config:', data.config.length);
            await Config.bulkCreate(data.config, { ignoreDuplicates: true });
        }
        
        if (data.tickets) { console.log('Tickets:', data.tickets.length); await Ticket.bulkCreate(data.tickets, { ignoreDuplicates: true }); }
        if (data.comments) { console.log('Comments:', data.comments.length); await Comment.bulkCreate(data.comments, { ignoreDuplicates: true }); }
        if (data.ticketCampoValores) { console.log('TicketCampoValores:', data.ticketCampoValores.length); await TicketCampoValor.bulkCreate(data.ticketCampoValores, { ignoreDuplicates: true }); }
        if (data.ticketBloqueos) { console.log('TicketBloqueos:', data.ticketBloqueos.length); await TicketBloqueoHistorial.bulkCreate(data.ticketBloqueos, { ignoreDuplicates: true }); }
        if (data.areaAccesoExtra) { console.log('AreaAccesoExtra:', data.areaAccesoExtra.length); await AreaAccesoExtra.bulkCreate(data.areaAccesoExtra, { ignoreDuplicates: true }); }
        
        console.log('Importación finalizada con éxito.');
    } catch(e) {
        console.error('Error durante la importación:', e);
    } finally {
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
        process.exit();
    }
}
importData();
