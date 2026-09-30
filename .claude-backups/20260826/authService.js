import { getUserByEmail as getInternalUserByEmail } from './userService';
import { getContactByEmail } from './companyService';

const STORAGE_KEY_AUTH = 'tms_current_user';

// Login
export const login = (email, password) => {
    // Check internal users first
    let user = getInternalUserByEmail(email);
    
    // Check company contacts if not found
    if (!user) {
        user = getContactByEmail(email);
    }

    if (user && user.password === password) {
        const { password: _, ...userWithoutPassword } = user;
        localStorage.setItem(STORAGE_KEY_AUTH, JSON.stringify(userWithoutPassword));
        return userWithoutPassword;
    }
    return null;
};

// Logout
export const logout = () => {
    localStorage.removeItem(STORAGE_KEY_AUTH);
};

// Get current user
export const getCurrentUser = () => {
    const user = localStorage.getItem(STORAGE_KEY_AUTH);
    return user ? JSON.parse(user) : null;
};

// Check if user is authenticated
export const isAuthenticated = () => {
    return getCurrentUser() !== null;
};

// Check if user has role
export const hasRole = (role) => {
    const user = getCurrentUser();
    return user && user.role === role;
};
