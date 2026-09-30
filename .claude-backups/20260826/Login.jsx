import './Login.css';
import { useState } from 'react';
import { IoMailOutline, IoLockClosedOutline, IoLogoLinkedin } from 'react-icons/io5';

export default function Login({ onLogin }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        setError('');

        if (!email || !password) {
            setError('Por favor completa todos los campos');
            return;
        }

        const success = onLogin(email, password);
        if (!success) {
            setError('Credenciales incorrectas');
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
