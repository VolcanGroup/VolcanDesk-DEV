const { sendHtmlEmail, templates } = require('./services/emailService');

const ticketMock = {
    id: 'VD-OPERACIONES-000003',
    description: 'Prueba de correos automáticos',
};

const commentMock = {
    text: 'Validación automática confirmada. Los íconos se eliminaron, el preheader funciona y el texto del comentario se inserta correctamente.',
};

const run = async () => {
    try {
        const html = templates.newComment(ticketMock, commentMock, 'Adrian González (Sistema)', 'Guillermo Martínez');
        await sendHtmlEmail('volcanoperaciones454@gmail.com', `Nuevo mensaje en [VD-${ticketMock.id}]`, html);
        console.log('Correo de prueba enviado.');
    } catch (e) {
        console.error(e);
    }
};

run();
