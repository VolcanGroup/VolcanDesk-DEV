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
    const deskGroupIds = cachedGroups.filter(g => g.modulo === 'volcan_desk').map(g => g.id);
    return !(user.groups || []).some(gid => deskGroupIds.includes(gid));
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

export const loadAreaAccesoExtra = async () => {
    try {
        return await api.get('/area-acceso-extra');
    } catch (error) {
        console.error('Failed to load area acceso extra', error);
        return [];
    }
};

export const createAreaAccesoExtra = async (data) => {
    return await api.post('/area-acceso-extra', data);
};

export const deleteAreaAccesoExtra = async (id) => {
    return await api.delete(`/area-acceso-extra/${id}`);
};
