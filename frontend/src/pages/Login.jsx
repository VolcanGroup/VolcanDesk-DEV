import './Login.css';
import { useState } from 'react';
import { IoMailOutline, IoLockClosedOutline, IoLogoLinkedin } from 'react-icons/io5';
import { forgotPassword } from '../services/authService';

export default function Login({ onLogin }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');

    // Vista "olvidé mi contraseña" — inline en la misma tarjeta, sin router.
    const [mode, setMode] = useState('login'); // 'login' | 'forgot'
    const [forgotEmail, setForgotEmail] = useState('');
    const [forgotMessage, setForgotMessage] = useState('');
    const [forgotError, setForgotError] = useState('');
    const [forgotLoading, setForgotLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');

        if (!email || !password) {
            setError('Por favor completa todos los campos');
            return;
        }

        const success = await onLogin(email, password);
        if (!success) {
            setError('Credenciales incorrectas');
        }
    };

    const handleForgotSubmit = async (e) => {
        e.preventDefault();
        setForgotError('');
        setForgotMessage('');

        if (!forgotEmail) {
            setForgotError('Ingresa tu correo');
            return;
        }

        setForgotLoading(true);
        try {
            const res = await forgotPassword(forgotEmail);
            setForgotMessage(res?.message || 'Si el correo está registrado, se envió un enlace para recuperar la contraseña.');
        } catch (err) {
            setForgotError(err.message || 'No se pudo enviar el correo. Intenta de nuevo.');
        } finally {
            setForgotLoading(false);
        }
    };

    if (mode === 'forgot') {
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
                        <h2 className="fade-in-voltik">Recuperar contraseña</h2>
                        <p className="fade-in-instructions">Te enviaremos un enlace a tu correo para restablecerla</p>
                    </div>

                    {forgotMessage ? (
                        <div className="login-form">
                            <p style={{ textAlign: 'center', color: '#1D1D1F', fontSize: 'var(--font-size-sm)' }}>{forgotMessage}</p>
                            <button type="button" className="btn btn-primary btn-lg w-full" style={{ marginTop: 'var(--spacing-lg)' }} onClick={() => { setMode('login'); setForgotEmail(''); setForgotMessage(''); }}>
                                Volver a iniciar sesión
                            </button>
                        </div>
                    ) : (
                        <form onSubmit={handleForgotSubmit} className="login-form">
                            {forgotError && (
                                <div className="login-error">
                                    {forgotError}
                                </div>
                            )}

                            <div className="input-group">
                                <label>Email</label>
                                <div className="input-with-icon">
                                    <IoMailOutline className="input-icon" />
                                    <input
                                        type="email"
                                        placeholder="tu@email.com"
                                        value={forgotEmail}
                                        onChange={(e) => setForgotEmail(e.target.value)}
                                    />
                                </div>
                            </div>

                            <button type="submit" className="btn btn-primary btn-lg w-full" disabled={forgotLoading}>
                                {forgotLoading ? 'Enviando...' : 'Enviar enlace de recuperación'}
                            </button>

                            <button type="button" className="login-forgot-back" onClick={() => setMode('login')}>
                                Volver a iniciar sesión
                            </button>
                        </form>
                    )}
                </div>
            </div>
        );
    }

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
                    <h2 className="fade-in-voltik">Accediendo a Voltik</h2>
                    <p className="fade-in-instructions">Inicia sesión para continuar</p>
                </div>

                <form onSubmit={handleSubmit} className="login-form">
                    {error && (
                        <div className="login-error">
                            {error}
                        </div>
                    )}

                    <div className="input-group">
                        <label>Email</label>
                        <div className="input-with-icon">
                            <IoMailOutline className="input-icon" />
                            <input
                                type="email"
                                placeholder="tu@email.com"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="input-group">
                        <label>Contraseña</label>
                        <div className="input-with-icon">
                            <IoLockClosedOutline className="input-icon" />
                            <input
                                type="password"
                                placeholder="••••••••"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                            />
                        </div>
                    </div>

                    <button type="submit" className="btn btn-primary btn-lg w-full">
                        Iniciar Sesión
                    </button>

                    <button type="button" className="login-forgot-back" onClick={() => setMode('forgot')}>
                        ¿Olvidaste tu contraseña?
                    </button>
                </form>

                <div className="login-demo">
                    <p className="text-muted">Credenciales de demo:</p>
                    <div className="demo-credentials">
                        <div>
                            <strong>Admin:</strong> admin@example.com / admin123
                        </div>
                        <div>
                            <strong>Agent:</strong> maria@example.com / agent123
                        </div>
                        <div>
                            <strong>User:</strong> juan@example.com / user123
                        </div>
                    </div>
                </div>

                <div className="login-footer-social">
                    <span className="social-text">Síguenos en</span>
                    <a href="https://www.linkedin.com/company/volcan-group/posts/?feedView=all" target="_blank" rel="noopener noreferrer" className="social-link" title="Volcán Group en LinkedIn">
                        <IoLogoLinkedin size={20} />
                    </a>
                </div>
            </div>
        </div>
    );
}
