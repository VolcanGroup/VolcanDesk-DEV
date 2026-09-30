import { api } from './api';
import { generateId } from '../utils/helpers';

let cachedGroups = [];

// Default support groups to seed if database is empty
const DEFAULTS = [
    { id: 'ig1', name: 'Operaciones', description: 'Grupo de operaciones generales', modulo: 'voltik', createdAt: new Date().toISOString() },
    { id: 'ig2', name: 'Contracargos', description: 'Gestión de contracargos', modulo: 'voltik', createdAt: new Date().toISOString() },
    { id: 'ig3', name: 'Implementación', description: 'Soporte de implementación', modulo: 'voltik', createdAt: new Date().toISOString() },
];

// Load support groups from server (called when App starts)
export const loadGroupsFromServer = async () => {
    try {
        let groups = await api.get('/groups');
        if (groups.length === 0) {
            console.log('Database has no support groups. Seeding defaults...');
            for (const group of DEFAULTS) {
                await api.post('/groups', group);
            }
            groups = await api.get('/groups');
        }
        cachedGroups = groups;
        return cachedGroups;
    } catch (error) {
        console.error('Failed to load support groups from server, using local fallback:', error);
        const local = localStorage.getItem('tms_internal_groups');
        cachedGroups = local ? JSON.parse(local) : DEFAULTS;
        return cachedGroups;
    }
};

// Get all support groups (sync)
export const getGroups = () => {
    return cachedGroups;
};

// Get support group by ID (sync)
export const getGroupById = (id) => {
    return cachedGroups.find(g => g.id === id);
};

// Usuario "solo solicitante" en Volcán Desk: pertenece al módulo interno pero no
// integra ningún grupo resolutor de ese módulo, es decir, únicamente levanta
// tickets para que otra área los atienda (nunca los gestiona). No afecta Voltik:
// un usuario con modulo='voltik' siempre da false aquí.
export const isDeskRequesterOnly = (user) => {
    if (!user || user.role === 'admin' || user.role === 'client') return false;
    if ((user.modulo || 'voltik') !== 'volcan_desk') return false;
    // Un group_admin siempre integra su propio grupo administrado (admin_group_id),
    // aunque su array `groups` esté vacío/desactualizado — sin esto, un group_admin
    // con `groups: []` (caso real: Javier Polanco) se clasificaba como "solo
    // solicitante" y perdía Inicio/Reportes en el Sidebar (bug reportado en vivo
    // 2026-09-07), a pesar de administrar un grupo resolutor real.
    if (user.role === 'group_admin' && user.admin_group_id) return false;
    const deskGroupIds = cachedGroups.filter(g => g.modulo === 'volcan_desk').map(g => g.id);
    // Mismo hueco que ya se corrigió en getUserGroupsForScoping (ticketService.js)
    // el 2026-09-16, aplicado aquí también (2026-09-17): un usuario cuyo único
    // acceso a un grupo viene de un Acceso Especial (AreaAccesoExtra), sin
    // pertenecer nativamente a ningún grupo, se clasificaba como "solo
    // solicitante" y perdía Inicio — caso real reportado en vivo, cuenta
    // "Kendy test" con 3 accesos especiales y `groups: []`.
    const allGroupIds = [...(user.groups || []), ...getMyExtraGroupIds(user)];
    return !allGroupIds.some(gid => deskGroupIds.includes(gid));
};

// Create support group (optimistic sync cache + async DB write)
export const createGroup = (data) => {
    const newGroup = {
        id: generateId(),
        name: data.name.trim(),
        description: data.description?.trim() || '',
        modulo: data.modulo || 'voltik',
        createdAt: new Date().toISOString(),
    };
    cachedGroups = [...cachedGroups, newGroup];
    api.post('/groups', newGroup).catch(err => console.error('Error creating group:', err));
    return newGroup;
};

// Update support group
export const updateGroup = (id, data) => {
    const groupIndex = cachedGroups.findIndex(g => g.id === id);
    if (groupIndex === -1) return null;

    const updated = {
        ...cachedGroups[groupIndex],
        ...data,
        updatedAt: new Date().toISOString()
    };
    cachedGroups = [
        ...cachedGroups.slice(0, groupIndex),
        updated,
        ...cachedGroups.slice(groupIndex + 1)
    ];
    api.put(`/groups/${id}`, updated).catch(err => console.error('Error updating group:', err));
    return updated;
};

// Delete support group (optimistic sync cache + async DB write)
export const deleteGroup = (id) => {
    cachedGroups = cachedGroups.filter(g => g.id !== id);
    
    // Background write
    api.delete(`/groups/${id}`).catch(err => console.error('Error deleting support group on server:', err));
    
    localStorage.setItem('tms_internal_groups', JSON.stringify(cachedGroups));
};

// ─── AREA ACCESO EXTRA (Permisos cruzados) ───────────────────────────────────

let cachedAreaAccesoExtra = [];

export const loadAreaAccesoExtra = async () => {
    try {
        const data = await api.get('/area-acceso-extra');
        cachedAreaAccesoExtra = data || [];
        return cachedAreaAccesoExtra;
    } catch (error) {
        console.error('Failed to load area acceso extra', error);
        cachedAreaAccesoExtra = [];
        return [];
    }
};

// Grupos extra otorgados al usuario actual vía Accesos Especiales (Usuarios >
// Accesos Especiales) — no requiere ser miembro nativo (`groups`) ni
// group_admin de esos grupos. GET /api/area-acceso-extra (server.js) ya
// devuelve solo las propias filas del caller cuando no es 'admin', así que
// este caché (cargado una vez al iniciar sesión, ver App.jsx) ya viene
// acotado correctamente sin filtrar de nuevo aquí (2026-09-16, a pedido del
// usuario — caso real: un director con visibilidad sobre varios grupos sin
// ser su admin ni pertenecer nativamente a ellos).
export const getMyExtraGroupIds = (currentUser) => {
    if (!currentUser) return [];
    return cachedAreaAccesoExtra
        .filter(a => a.usuario_id === currentUser.id)
        .map(a => a.area_id);
};

export const createAreaAccesoExtra = async (data) => {
    return await api.post('/area-acceso-extra', data);
};

export const deleteAreaAccesoExtra = async (id) => {
    return await api.delete(`/area-acceso-extra/${id}`);
};
