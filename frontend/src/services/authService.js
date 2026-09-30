import { api } from './api';

const STORAGE_KEY_AUTH = 'tms_current_user';

// Login: el password se valida en el servidor (POST /api/auth/login) contra
// el hash guardado en la BD — antes esto comparaba en texto plano en el
// propio navegador contra la lista completa de usuarios (con password)
// descargada sin autenticación.
export const login = async (email, password) => {
    try {
        const userWithoutPassword = await api.post('/auth/login', { email, password });
        localStorage.setItem(STORAGE_KEY_AUTH, JSON.stringify(userWithoutPassword));
        return userWithoutPassword;
    } catch (error) {
        return null;
    }
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

// Cambiar la propia contraseña estando logueado (PUT /api/auth/password ya
// resuelve el usuario desde el header x-user-id, no hace falta pasar el id).
export const changePassword = (currentPassword, newPassword) => {
    return api.put('/auth/password', { currentPassword, newPassword });
};

// Solicitar el correo de recuperación de contraseña.
export const forgotPassword = (email) => {
    return api.post('/auth/forgot-password', { email });
};

// Confirmar la recuperación con el token del correo.
export const resetPassword = (token, newPassword) => {
    return api.post('/auth/reset-password', { token, newPassword });
};
