import { api } from './api';
import { generateId } from '../utils/helpers';

let cachedUsers = [];

// Antes había aquí una lista de usuarios "por defecto" (con contraseñas reales
// como 'admin123' y 'AdrianTkt2026!' en texto plano) para auto-sembrar la BD
// si estaba vacía, y como fallback si el servidor no respondía — pero eso
// significaba enviar credenciales reales a cualquiera que descargara el
// bundle del frontend. Se quitó: ya no hay auto-seed desde el cliente (la BD
// de este ambiente ya tiene usuarios reales) y el fallback de red ahora es
// simplemente la caché de localStorage si existe, sin datos hardcodeados.
export const loadUsersFromServer = async () => {
    try {
        const users = await api.get('/users');
        cachedUsers = users;
        return cachedUsers;
    } catch (error) {
        console.error('Failed to load users from server, falling back to localStorage:', error);
        const local = localStorage.getItem('tms_users');
        cachedUsers = local ? JSON.parse(local) : [];
        return cachedUsers;
    }
};

// Get all users (sync)
export const getUsers = () => {
    return cachedUsers;
};

// Get user by ID (sync)
export const getUserById = (id) => {
    return cachedUsers.find(user => user.id === id);
};

// Get user by email (sync)
export const getUserByEmail = (email) => {
    return cachedUsers.find(user => user.email === email);
};

// Create user (optimistic sync cache + async DB write)
export const createUser = (userData) => {
    const newUser = {
        id: generateId(),
        ...userData,
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(userData.name)}&background=random&color=fff`,
        createdAt: new Date().toISOString(),
    };
    cachedUsers.push(newUser);
    
    // Background write
    api.post('/users', newUser).catch(err => console.error('Error creating user on server:', err));
    
    // Keep localstorage as fallback
    localStorage.setItem('tms_users', JSON.stringify(cachedUsers));
    return newUser;
};

// Update user (optimistic sync cache + async DB write)
export const updateUser = (id, updates) => {
    const index = cachedUsers.findIndex(user => user.id === id);
    if (index !== -1) {
        cachedUsers[index] = { ...cachedUsers[index], ...updates };
        
        // Background write
        api.put(`/users/${id}`, updates).catch(err => console.error('Error updating user on server:', err));
        
        localStorage.setItem('tms_users', JSON.stringify(cachedUsers));
        return cachedUsers[index];
    }
    return null;
};

// Delete user (optimistic sync cache + async DB write)
export const deleteUser = (id) => {
    cachedUsers = cachedUsers.filter(user => user.id !== id);
    
    // Background write
    api.delete(`/users/${id}`).catch(err => console.error('Error deleting user on server:', err));
    
    localStorage.setItem('tms_users', JSON.stringify(cachedUsers));
    return true;
};

// Get users by role (sync)
export const getUsersByRole = (role) => {
    return cachedUsers.filter(user => user.role === role);
};
