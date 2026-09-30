const nodemailer = require('nodemailer');
require('dotenv').config();

// Configuración del transporter usando las variables de entorno
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: process.env.SMTP_SECURE === 'true' || true,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    }
});

const getBaseUrl = () => {
    return process.env.FRONTEND_URL || 'http://10.23.105.36:5173';
};

const sendHtmlEmail = async (to, subject, html) => {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.warn('No hay configuración SMTP. Omitiendo correo a:', to);
        return;
    }
    if (!to) return;

    // Sin <meta charset="utf-8"> algunos clientes de correo (confirmado en vivo,
    // 2026-09-14: Gmail) adivinan mal la codificación del HTML y los acentos
    // salen como "Mart�nez" en vez de "Martínez" — el charset del header MIME
    // (que nodemailer sí pone bien) no basta por sí solo para todos los
    // clientes. encoding:'base64' fuerza una codificación de transporte segura
    // para bytes UTF-8 en vez de dejarlo en 7bit/quoted-printable automático.
    const fullHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>${html}</body></html>`;

    try {
        await transporter.sendMail({
            from: `"Volcán Desk" <${process.env.SMTP_USER}>`,
            to,
            subject,
            html: fullHtml,
            encoding: 'base64',
        });
        console.log(`Correo enviado exitosamente a: ${to} - Asunto: ${subject}`);
    } catch (error) {
        console.error('Error enviando correo:', error);
    }
};

const templates = {
    // 1. Ticket nuevo asignado a un usuario específico
    // priorityLabel: el nombre visible ("Alta"), no ticket.priority crudo —
    // ese campo guarda el "value" interno del catálogo por grupo (ej.
    // "alta__1789411331545-z6pep7iom"), que es justo lo que salía en el
    // correo antes de este fix (reportado en vivo 2026-09-17).
    newTicketUser: (ticket, user, creatorName, priorityLabel) => {
        const ticketUrl = `${getBaseUrl()}/tickets/${ticket.id}`;
        return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 8px;">
            <div style="background: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <h2 style="color: #333333; margin-top: 0;">Nuevo Ticket Asignado</h2>
                <p style="font-size: 16px; color: #555;">Hola <strong>${user.name}</strong>,</p>
                <p style="font-size: 16px; color: #555;">Se te ha asignado un nuevo ticket en Volcán Desk.</p>
                
                <div style="background: #f4f6f8; padding: 15px; border-left: 4px solid #3b82f6; margin: 20px 0; border-radius: 4px;">
                    <p style="margin: 5px 0;"><strong>Folio:</strong> ${ticket.id}</p>
                    <p style="margin: 5px 0;"><strong>Solicitante:</strong> ${creatorName}</p>
                    <p style="margin: 5px 0;"><strong>Prioridad:</strong> ${priorityLabel}</p>
                    <p style="margin: 10px 0 5px 0;"><strong>Descripción:</strong></p>
                    <p style="margin: 0; color: #666; font-style: italic;">"${ticket.description}"</p>
                </div>

                <div style="text-align: center; margin-top: 30px;">
                    <a href="${ticketUrl}" style="background-color: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Ver Ticket en Volcán Desk</a>
                </div>
            </div>
            <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">Este es un mensaje automático de Volcán Desk. Por favor no respondas a este correo.</p>
        </div>
        `;
    },

    // 2. Ticket nuevo sin asignación (Bandeja de grupo)
    newTicketGroup: (ticket, groupName, creatorName, priorityLabel) => {
        const ticketUrl = `${getBaseUrl()}/tickets/${ticket.id}`;
        return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 8px;">
            <div style="background: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <h2 style="color: #333333; margin-top: 0;">Nuevo Ticket para el grupo ${groupName}</h2>
                <p style="font-size: 16px; color: #555;">Hola Equipo,</p>
                <p style="font-size: 16px; color: #555;">Hay un nuevo ticket esperando asignación en su bandeja.</p>
                
                <div style="background: #f4f6f8; padding: 15px; border-left: 4px solid #3b82f6; margin: 20px 0; border-radius: 4px;">
                    <p style="margin: 5px 0;"><strong>Folio:</strong> ${ticket.id}</p>
                    <p style="margin: 5px 0;"><strong>Solicitante:</strong> ${creatorName}</p>
                    <p style="margin: 5px 0;"><strong>Prioridad:</strong> ${priorityLabel}</p>
                    <p style="margin: 10px 0 5px 0;"><strong>Descripción:</strong></p>
                    <p style="margin: 0; color: #666; font-style: italic;">"${ticket.description}"</p>
                </div>

                <div style="text-align: center; margin-top: 30px;">
                    <a href="${ticketUrl}" style="background-color: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Ver y Tomar Ticket</a>
                </div>
            </div>
            <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">Este es un mensaje automático de Volcán Desk.</p>
        </div>
        `;
    },

    // 3b. Nuevo apoyo solicitado a un grupo (agregado 2026-09-14)
    newApoyoGroup: (ticket, groupName, requesterName) => {
        const ticketUrl = `${getBaseUrl()}/tickets/${ticket.id}`;
        return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 8px;">
            <div style="background: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <h2 style="color: #333333; margin-top: 0;">Solicitud de apoyo para ${groupName}</h2>
                <p style="font-size: 16px; color: #555;">Hola Equipo,</p>
                <p style="font-size: 16px; color: #555;"><strong>${requesterName}</strong> solicitó el apoyo de su grupo en un ticket.</p>

                <div style="background: #f4f6f8; padding: 15px; border-left: 4px solid #f59e0b; margin: 20px 0; border-radius: 4px;">
                    <p style="margin: 5px 0;"><strong>Folio:</strong> ${ticket.id}</p>
                    <p style="margin: 5px 0;"><strong>Asunto:</strong> ${ticket.title}</p>
                </div>

                <div style="text-align: center; margin-top: 30px;">
                    <a href="${ticketUrl}" style="background-color: #f59e0b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Ver Ticket</a>
                </div>
            </div>
            <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">Este es un mensaje automático de Volcán Desk.</p>
        </div>
        `;
    },

    // 3c. Mención directa en un comentario (agregado 2026-09-14)
    mention: (ticket, comment, authorName, recipientName) => {
        const ticketUrl = `${getBaseUrl()}/tickets/${ticket.id}`;
        return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 8px;">
            <div style="background: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <h2 style="color: #333333; margin-top: 0; font-size: 20px;">Te mencionaron en un ticket</h2>
                <p style="font-size: 16px; color: #555;">Hola <strong>${recipientName}</strong>,</p>
                <p style="font-size: 16px; color: #555;"><strong>${authorName}</strong> te mencionó en el ticket ${ticket.id}:</p>

                <div style="background: #f4f6f8; padding: 15px; border-left: 4px solid #8e44ad; margin: 20px 0; border-radius: 4px;">
                    <p style="margin: 0; color: #444; font-size: 15px; line-height: 1.5;">"${comment.text}"</p>
                </div>

                <div style="text-align: center; margin-top: 30px;">
                    <a href="${ticketUrl}" style="background-color: #8e44ad; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Ver Ticket</a>
                </div>
            </div>
            <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">Este es un mensaje automático de Volcán Desk.</p>
        </div>
        `;
    },

    // 3. Nuevo comentario (Respuesta cruzada)
    newComment: (ticket, comment, authorName, recipientName) => {
        const ticketUrl = `${getBaseUrl()}/tickets/${ticket.id}`;
        return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 8px;">
            <div style="display: none; max-height: 0px; overflow: hidden;">
                ${authorName} ha agregado una respuesta en tu ticket ${ticket.id}
            </div>
            <div style="background: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <h2 style="color: #333333; margin-top: 0; font-size: 20px;">Actualización del Ticket</h2>
                <p style="font-size: 16px; color: #555;">Hola <strong>${recipientName}</strong>,</p>
                <p style="font-size: 16px; color: #555;"><strong>${authorName}</strong> ha agregado una respuesta en tu ticket:</p>
                
                <div style="background: #f4f6f8; padding: 15px; border-left: 4px solid #10b981; margin: 20px 0; border-radius: 4px;">
                    <p style="margin: 0; color: #444; font-size: 15px; line-height: 1.5;">"${comment.text}"</p>
                </div>
                
                <div style="text-align: center; margin-top: 30px;">
                    <a href="${ticketUrl}" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Responder al Ticket</a>
                </div>
            </div>
            <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">Este es un mensaje automático de Volcán Desk.</p>
        </div>
        `;
    },

    // Recuperar contraseña — el link incluye el token de un solo uso, expira en 1h.
    passwordReset: (user, resetUrl) => {
        return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px; border-radius: 8px;">
            <div style="background: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <h2 style="color: #333333; margin-top: 0;">Recuperar contraseña</h2>
                <p style="font-size: 16px; color: #555;">Hola <strong>${user.name}</strong>,</p>
                <p style="font-size: 16px; color: #555;">Recibimos una solicitud para restablecer tu contraseña en Volcán Desk. Si no fuiste tú, puedes ignorar este correo.</p>

                <div style="text-align: center; margin-top: 30px;">
                    <a href="${resetUrl}" style="background-color: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Restablecer contraseña</a>
                </div>
                <p style="font-size: 13px; color: #999; margin-top: 20px;">Este enlace expira en 1 hora.</p>
            </div>
            <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">Este es un mensaje automático de Volcán Desk. Por favor no respondas a este correo.</p>
        </div>
        `;
    }
};

module.exports = {
    sendHtmlEmail,
    templates
};
