import { api } from './api';

// Antes esto vivía 100% en localStorage del navegador que disparaba la
// acción — nunca llegaba a otro usuario ni a otro dispositivo/pestaña, que
// era la causa real de "las notificaciones no funcionan". Ahora hablan con
// /api/notifications (persistidas en DB), así que cualquier sesión del
// destinatario las ve por su propio polling.

// Trae las notificaciones del usuario actual (el backend las filtra por el
// header x-user-id, que ya manda `api` automáticamente).
export const getNotifications = async () => {
    try {
        return await api.get('/notifications');
    } catch (err) {
        console.error('Error cargando notificaciones:', err);
        return [];
    }
};

export const getUnreadCount = async () => {
    const all = await getNotifications();
    return all.filter(n => !n.read).length;
};

// Crea una o varias notificaciones de un solo golpe (ej. avisar a todo un
// grupo cuando llega un ticket nuevo o se escala uno hacia ellos). Cada item:
// {fromUser: {id, name}, toUserId, ticketId, ticketTitle, message, type}.
export const sendNotifications = (items) => {
    if (!items || items.length === 0) return Promise.resolve();
    return api.post('/notifications', items).catch(err => console.error('Error creando notificaciones:', err));
};

// Compat: una sola notificación (usado por @menciones en TicketDetailView).
export const addNotification = (item) => sendNotifications([item]);

export const markAllRead = () =>
    api.put('/notifications/read-all', {}).catch(err => console.error('Error marcando notificaciones leídas:', err));

export const markRead = (notifId) =>
    api.put(`/notifications/${notifId}/read`, {}).catch(err => console.error('Error marcando notificación leída:', err));

export const clearNotification = (notifId) =>
    api.delete(`/notifications/${notifId}`).catch(err => console.error('Error borrando notificación:', err));
