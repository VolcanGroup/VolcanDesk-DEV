import './Login.css';
import { useState } from 'react';
import { IoLockClosedOutline } from 'react-icons/io5';
import { resetPassword } from '../services/authService';

// Se monta cuando App.jsx detecta window.location.pathname === '/reset-password'
// (link mandado por correo desde POST /api/auth/forgot-password), antes de
// exigir sesión — igual patrón que ya usa App.jsx para links de ticket
// compartidos. Reutiliza los estilos de Login.css, es la misma tarjeta.
export default function ResetPassword({ token }) {
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);
    const [loading, setLoading] = useState(false);

    const goToLogin = () => {
        window.history.replaceState({}, '', '/');
        window.location.reload();
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');

        if (!newPassword || !confirmPassword) {
            setError('Completa ambos campos');
            return;
        }
        if (newPassword.length < 6) {
            setError('La contraseña debe tener al menos 6 caracteres');
            return;
        }
        if (newPassword !== confirmPassword) {
            setError('Las contraseñas no coinciden');
            return;
        }

        setLoading(true);
        try {
            await resetPassword(token, newPassword);
            setSuccess(true);
        } catch (err) {
            setError(err.message || 'El enlace no es válido o ya expiró.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-container">
            <div className="login-background">
                <div className="login-gradient"></div>
            </div>

            <div className="login-card">
                <div className="login-header">
                    <div className="login-logo fade-in-volcan">
                        <img src="/Logo_Volcaìn_sin_fondo.png" alt="VOLCÁN" />
                    </div>
                    <h2 className="fade-in-voltik">Restablecer contraseña</h2>
                    {!success && <p className="fade-in-instructions">Elige tu nueva contraseña</p>}
                </div>

                {success ? (
                    <div className="login-form">
                        <p style={{ textAlign: 'center', color: '#1D1D1F', fontSize: 'var(--font-size-sm)' }}>
                            Tu contraseña se actualizó correctamente.
                        </p>
                        <button type="button" className="btn btn-primary btn-lg w-full" style={{ marginTop: 'var(--spacing-lg)' }} onClick={goToLogin}>
                            Iniciar sesión
                        </button>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit} className="login-form">
                        {error && (
                            <div className="login-error">
                                {error}
                            </div>
                        )}

                        <div className="input-group">
                            <label>Nueva contraseña</label>
                            <div className="input-with-icon">
                                <IoLockClosedOutline className="input-icon" />
                                <input
                                    type="password"
                                    placeholder="••••••••"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                />
                            </div>
                        </div>

                        <div className="input-group">
                            <label>Confirmar contraseña</label>
                            <div className="input-with-icon">
                                <IoLockClosedOutline className="input-icon" />
                                <input
                                    type="password"
                                    placeholder="••••••••"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                />
                            </div>
                        </div>

                        <button type="submit" className="btn btn-primary btn-lg w-full" disabled={loading}>
                            {loading ? 'Guardando...' : 'Restablecer contraseña'}
                        </button>

                        <button type="button" className="login-forgot-back" onClick={goToLogin}>
                            Volver a iniciar sesión
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}
