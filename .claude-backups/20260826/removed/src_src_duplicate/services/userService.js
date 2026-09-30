import { api } from './api';
import { generateId } from '../utils/helpers';

let cachedUsers = [];

// Default users to seed if database is empty
const defaultUsers = [
    {
        id: '1',
        name: 'Admin User',
        email: 'admin@example.com',
        password: 'admin123',
        role: 'admin',
        groups: ['ig1', 'ig2', 'ig3'],
        avatar: 'https://ui-avatars.com/api/?name=Admin+User&background=8b5cf6&color=fff',
        createdAt: new Date().toISOString(),
    },
    {
        id: '2',
        name: 'María González',
        email: 'maria@example.com',
        password: 'agent123',
        role: 'agent',
        groups: ['ig1'],
        avatar: 'https://ui-avatars.com/api/?name=Maria+Gonzalez&background=06b6d4&color=fff',
        createdAt: new Date().toISOString(),
    },
    {
        id: 'su1',
        name: 'Supervisor General',
        email: 'super@example.com',
        password: 'super123',
        role: 'supervisor',
        groups: ['ig1', 'ig2', 'ig3'],
        avatar: 'https://ui-avatars.com/api/?name=Supervisor+General&background=10b981&color=fff',
        createdAt: new Date().toISOString()
    },
    {
        id: 'adrian_gonzalez',
        name: 'Adrian Gonzalez',
        email: 'adrian@example.com',
        password: 'AdrianTkt2026!',
        role: 'admin',
        groups: ['ig1', 'ig2', 'ig3'],
        avatar: 'https://ui-avatars.com/api/?name=Adrian+Gonzalez&background=3b82f6&color=fff',
        createdAt: new Date().toISOString()
    }
];

// Initialize users from server (called when App starts)
export const loadUsersFromServer = async () => {
    try {
        let users = await api.get('/users');
        if (users.length === 0) {
            console.log('Database has no users. Seeding default users...');
            for (const user of defaultUsers) {
                await api.post('/users', user);
            }
            users = await api.get('/users');
        }
        cachedUsers = users;
        return cachedUsers;
    } catch (error) {
        console.error('Failed to load users from server, falling back to localStorage:', error);
        const local = localStorage.getItem('tms_users');
        if (local) {
            cachedUsers = JSON.parse(local);
        } else {
            cachedUsers = defaultUsers;
            localStorage.setItem('tms_users', JSON.stringify(defaultUsers));
        }
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
