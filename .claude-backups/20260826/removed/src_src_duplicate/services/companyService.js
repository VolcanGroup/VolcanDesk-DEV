import { api } from './api';
import { generateId } from '../utils/helpers';
import { getUsers, createUser, updateUser, deleteUser } from './userService';

let cachedCompanies = [];

// Load companies from server
export const loadCompaniesFromServer = async () => {
    try {
        const companies = await api.get('/companies');
        cachedCompanies = companies;
        return cachedCompanies;
    } catch (error) {
        console.error('Failed to load companies, using local fallback:', error);
        const local = localStorage.getItem('tms_companies');
        cachedCompanies = local ? JSON.parse(local) : [];
        return cachedCompanies;
    }
};

// Get all companies (sync)
export const getCompanies = () => {
    return cachedCompanies;
};

// Get company by ID (sync)
export const getCompanyById = (id) => {
    return cachedCompanies.find(c => c.id === id);
};

// Create company (optimistic sync cache + async DB write)
export const createCompany = (data) => {
    const newCompany = {
        id: generateId(),
        name: data.name.trim(),
        emisor: data.emisor?.trim() || '',
        tipoSaldos: data.tipoSaldos || 'internos',
        tipoBin: data.tipoBin || 'sponsor',
        embozador: data.embozador || '',
        contactosPrincipales: data.contactosPrincipales || [],
        funcionariosAdjunto: data.funcionariosAdjunto || null,
        notes: data.notes || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    cachedCompanies.push(newCompany);
    
    // Background write
    api.post('/companies', newCompany).catch(err => console.error('Error creating company on server:', err));
    
    localStorage.setItem('tms_companies', JSON.stringify(cachedCompanies));
    return newCompany;
};

// Update company (optimistic sync cache + async DB write)
export const updateCompany = (id, updates) => {
    const idx = cachedCompanies.findIndex(c => c.id === id);
    if (idx !== -1) {
        cachedCompanies[idx] = { 
            ...cachedCompanies[idx], 
            ...updates, 
            updatedAt: new Date().toISOString() 
        };
        
        // Background write
        api.put(`/companies/${id}`, updates).catch(err => console.error('Error updating company on server:', err));
        
        localStorage.setItem('tms_companies', JSON.stringify(cachedCompanies));
        return cachedCompanies[idx];
    }
    return null;
};

// Delete company (optimistic sync cache + async DB write)
export const deleteCompany = (id) => {
    cachedCompanies = cachedCompanies.filter(c => c.id !== id);
    
    // Background write
    api.delete(`/companies/${id}`).catch(err => console.error('Error deleting company on server:', err));
    
    localStorage.setItem('tms_companies', JSON.stringify(cachedCompanies));
    
    // Also delete all contacts (users) of this company in background
    const companyContacts = getUsers().filter(u => u.companyId === id);
    for (const contact of companyContacts) {
        deleteUser(contact.id);
    }
};

// ─── Company Contacts (stored as Users with role 'client') ──────────────────────

// Get contacts (sync)
export const getContacts = (companyId = null) => {
    const clients = getUsers().filter(u => u.role === 'client');
    return companyId ? clients.filter(c => c.companyId === companyId) : clients;
};

// Get contact by ID (sync)
export const getContactById = (id) => {
    return getUsers().find(u => u.id === id && u.role === 'client');
};

// Get contact by email (sync)
export const getContactByEmail = (email) => {
    return getUsers().find(u => u.email?.toLowerCase() === email?.toLowerCase() && u.role === 'client');
};

// Create contact (relies on createUser)
export const createContact = (data) => {
    const contactUser = {
        companyId: data.companyId,
        name: data.name.trim(),
        email: data.email.trim().toLowerCase(),
        password: data.password,
        phone: data.phone?.trim() || '',
        position: data.position?.trim() || '',
        role: 'client',
    };
    return createUser(contactUser);
};

// Update contact (relies on updateUser)
export const updateContact = (id, updates) => {
    return updateUser(id, updates);
};

// Delete contact (relies on deleteUser)
export const deleteContact = (id) => {
    return deleteUser(id);
};

// Get all contacts for auth (sync)
export const getAllContactsForAuth = () => {
    return getUsers().filter(u => u.role === 'client');
};
