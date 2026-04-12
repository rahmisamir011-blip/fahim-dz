/**
 * FAHIM DZ - Main JavaScript
 * Landing page interactions, animations, auth logic
 */

document.addEventListener('DOMContentLoaded', () => {

  // ============ NAVBAR SCROLL EFFECT ============
  const navbar = document.getElementById('navbar');
  const navLinks = document.querySelectorAll('.nav-link');

  const updateNavbar = () => {
    if (window.scrollY > 50) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }

    // Active section detection
    const sections = ['hero', 'features', 'showcase', 'pricing', 'faq'];
    let currentSection = 'hero';

    sections.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= 120 && rect.bottom > 120) {
          currentSection = id;
        }
      }
    });

    navLinks.forEach(link => {
      const section = link.dataset.section;
      if (section === currentSection) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });
  };

  window.addEventListener('scroll', updateNavbar, { passive: true });

  // Smooth scroll for nav links
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      if (href && href.startsWith('#')) {
        e.preventDefault();
        const target = document.querySelector(href);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        // Close mobile menu
        document.getElementById('nav-links').classList.remove('open');
      }
    });
  });

  // ============ MOBILE NAV TOGGLE ============
  const navToggle = document.getElementById('nav-toggle');
  const navLinksEl = document.getElementById('nav-links');

  if (navToggle) {
    navToggle.addEventListener('click', () => {
      navLinksEl.classList.toggle('open');
      // Animate hamburger
      const spans = navToggle.querySelectorAll('span');
      if (navLinksEl.classList.contains('open')) {
        spans[0].style.transform = 'rotate(45deg) translate(5px, 5px)';
        spans[1].style.opacity = '0';
        spans[2].style.transform = 'rotate(-45deg) translate(5px, -5px)';
      } else {
        spans[0].style.transform = '';
        spans[1].style.opacity = '';
        spans[2].style.transform = '';
      }
    });
  }

  // ============ SCROLL-TRIGGERED ANIMATIONS (AOS-like) ============
  const aosElements = document.querySelectorAll('[data-aos]');

  const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -40px 0px'
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('aos-animate');
        observer.unobserve(entry.target);
      }
    });
  }, observerOptions);

  aosElements.forEach(el => observer.observe(el));

  // ============ SHOWCASE TABS ============
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;

      // Update active tab btn
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Show correct panel
      tabPanels.forEach(panel => {
        panel.classList.remove('active');
        if (panel.id === `tab-${targetTab}`) {
          panel.classList.add('active');
        }
      });
    });
  });

  // ============ PRICING BUTTONS ============
  const buyBtns = document.querySelectorAll('.buy-btn');
  buyBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Redirect to auth if not logged in
      const isLoggedIn = Auth.isLoggedIn();
      if (!isLoggedIn) {
        window.location.href = 'authentification.html';
        return;
      }
      // Show payment modal
      showNotification('ستُحوَّل إلى صفحة الدفع...', 'info');
      setTimeout(() => {
        window.location.href = 'dashboard.html';
      }, 1500);
    });
  });

  // ============ COUNTER ANIMATION ============
  const animateCounter = (el, target, duration = 1500) => {
    let start = 0;
    const step = target / (duration / 16);
    const timer = setInterval(() => {
      start += step;
      if (start >= target) {
        start = target;
        clearInterval(timer);
      }
      el.textContent = Math.round(start).toLocaleString('ar-DZ');
    }, 16);
  };

  // Animate stats when visible
  const statWidgets = document.querySelectorAll('.stat-w-value');
  const statObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const el = entry.target;
        const text = el.textContent.trim();
        const numMatch = text.match(/[\d,]+/);
        if (numMatch) {
          const num = parseInt(numMatch[0].replace(/,/g, ''));
          if (!isNaN(num) && num > 0) {
            animateCounter(el, num, 1200);
          }
        }
        statObserver.unobserve(el);
      }
    });
  }, { threshold: 0.3 });

  statWidgets.forEach(el => statObserver.observe(el));

  // ============ SCROLL TO TOP ============
  const scrollTopBtn = document.createElement('button');
  scrollTopBtn.className = 'scroll-top';
  scrollTopBtn.innerHTML = '↑';
  scrollTopBtn.setAttribute('aria-label', 'Scroll to top');
  document.body.appendChild(scrollTopBtn);

  scrollTopBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  window.addEventListener('scroll', () => {
    if (window.scrollY > 400) {
      scrollTopBtn.classList.add('visible');
    } else {
      scrollTopBtn.classList.remove('visible');
    }
  }, { passive: true });

  // ============ LANGUAGE TOGGLE ============
  const langToggle = document.getElementById('lang-toggle');
  if (langToggle) {
    langToggle.addEventListener('click', () => {
      // For demo: just toggle between AR/FR
      const isAr = document.documentElement.lang === 'ar';
      if (isAr) {
        showNotification('الموقع يدعم العربية فقط حالياً', 'info');
      }
    });
  }

  // ============ CHAT BUBBLE TYPING ANIMATION ============
  const chatBubbles = document.querySelectorAll('.chat-bubble.outgoing');
  chatBubbles.forEach((bubble, i) => {
    bubble.style.animationDelay = `${0.3 + i * 0.5}s`;
  });

  // ============ FEATURE CARDS STAGGER ============
  const featureCards = document.querySelectorAll('.feature-card');
  featureCards.forEach((card, i) => {
    card.style.transitionDelay = `${i * 0.08}s`;
  });

  // ============ NOTIFICATION SYSTEM ============
  window.showNotification = (message, type = 'info') => {
    const notification = document.createElement('div');
    notification.className = `notification notification--${type}`;
    notification.innerHTML = `
      <div class="notif-content">
        <span class="notif-icon">${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
        <span>${message}</span>
      </div>
    `;

    // Add styles inline
    Object.assign(notification.style, {
      position: 'fixed',
      top: '90px',
      right: '24px',
      zIndex: '9999',
      background: type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : '#3b82f6',
      color: 'white',
      padding: '12px 20px',
      borderRadius: '12px',
      fontSize: '0.88rem',
      fontWeight: '600',
      fontFamily: 'Cairo, sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
      direction: 'rtl',
      animation: 'fadeInUp 0.3s ease',
      maxWidth: '300px'
    });

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.opacity = '0';
      notification.style.transform = 'translateY(-10px)';
      notification.style.transition = 'opacity 0.3s, transform 0.3s';
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  };

  // ============ FAQ ACCORDION (if needed) ============
  const faqCards = document.querySelectorAll('.faq-card');
  // Currently showing all, no accordion needed for this layout

  // ============ INIT ============
  updateNavbar();

  // Trigger initial AOS for hero elements (above fold)
  setTimeout(() => {
    document.querySelectorAll('[data-aos]').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight) {
        el.classList.add('aos-animate');
      }
    });
  }, 100);

});

// ============ AUTH MODULE ============
const Auth = {
  isLoggedIn() {
    return !!localStorage.getItem('fahim_token');
  },

  login(email, password) {
    return new Promise((resolve, reject) => {
      // Simulate API call
      setTimeout(() => {
        if (email && password && password.length >= 6) {
          const token = btoa(`${email}:${Date.now()}`);
          const user = {
            id: 'user_' + Math.random().toString(36).substring(2, 9),
            email,
            name: email.split('@')[0],
            points: 0,
            plan: null,
            createdAt: new Date().toISOString()
          };
          localStorage.setItem('fahim_token', token);
          localStorage.setItem('fahim_user', JSON.stringify(user));
          resolve({ token, user });
        } else {
          reject(new Error('بيانات غير صحيحة'));
        }
      }, 1000);
    });
  },

  register(name, email, password) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (name && email && password && password.length >= 6) {
          const token = btoa(`${email}:${Date.now()}`);
          const user = {
            id: 'user_' + Math.random().toString(36).substring(2, 9),
            email,
            name,
            points: 1000, // Welcome bonus
            plan: 'starter',
            createdAt: new Date().toISOString()
          };
          localStorage.setItem('fahim_token', token);
          localStorage.setItem('fahim_user', JSON.stringify(user));
          resolve({ token, user });
        } else {
          reject(new Error('الرجاء ملء جميع الحقول بشكل صحيح'));
        }
      }, 1200);
    });
  },

  logout() {
    localStorage.removeItem('fahim_token');
    localStorage.removeItem('fahim_user');
    window.location.href = 'index.html';
  },

  getUser() {
    try {
      return JSON.parse(localStorage.getItem('fahim_user') || 'null');
    } catch {
      return null;
    }
  },

  getToken() {
    return localStorage.getItem('fahim_token');
  }
};

// ============ POINTS/PRICING SYSTEM ============
const PointsSystem = {
  plans: [
    { id: 'starter', name: 'رصيد البداية', points: 1000, price: 3500, priceHT: 2941, tva: 559 },
    { id: 'growth', name: 'رصيد النمو', points: 5000, price: 8500, priceHT: 7143, tva: 1357 },
    { id: 'business', name: 'رصيد الأعمال', points: 10000, price: 14500, priceHT: 12185, tva: 2315 },
    { id: 'enterprise', name: 'رصيد المؤسسات', points: 25000, price: 36000, priceHT: 30252, tva: 5748 }
  ],

  purchase(planId) {
    const plan = this.plans.find(p => p.id === planId);
    if (!plan) throw new Error('الباقة غير موجودة');

    const user = Auth.getUser();
    if (!user) {
      window.location.href = 'authentification.html';
      return;
    }

    user.points = (user.points || 0) + plan.points;
    user.plan = planId;
    localStorage.setItem('fahim_user', JSON.stringify(user));

    return { success: true, points: user.points, plan };
  },

  deductPoint(user) {
    if (!user || user.points <= 0) return false;
    user.points -= 1;
    localStorage.setItem('fahim_user', JSON.stringify(user));
    return true;
  }
};

// ============ AI BOT SIMULATION ============
const FahimBot = {
  languages: ['ar', 'dz', 'fr', 'en'],

  // Simulated AI responses in Algerian Arabic dialect
  responses: {
    greeting: [
      'أهلاً وسهلاً! 👋 كيفاش نخدمك اليوم؟',
      'مرحبا بيك! 😊 شو يمكنني نعاونك؟',
      'سلام عليكم! كيفاش نخدمك؟'
    ],
    product_inquiry: [
      'واش تحب تشري منتج معين؟ قولي شو تحب! 🛍️',
      'عندنا منتجات كثيرة! شو يعجبك؟',
      'ايه! عندي معلومات على كل المنتجات. شو تبغا تعرف؟'
    ],
    price_inquiry: [
      'السعر هو {price} دج. واش يعجبك؟ 💰',
      'المنتج بيتباع بـ {price} د.ج فقط!',
      'قيمتو {price} دج. أوفر سعر في السوق! 🎯'
    ],
    order_confirm: [
      'ممتاز! ✅ تأكدت الطلبية. رقمها #{orderId}',
      'تم! 🎉 طلبيتك رقم #{orderId} قيد المعالجة.',
      'براڤو! الطلبية تأكدت. رقم التتبع: #{orderId}'
    ],
    unknown: [
      'سامحني، ما فهمتش زين. ممكن تعيد؟ 🙏',
      'عفواً، ما قدرتش نفهم. ممكن توضحلي أكثر؟',
      'انتظر شوية، راح نحولك لموظف بشري! 🚀'
    ]
  },

  generateResponse(message) {
    const msg = message.toLowerCase().trim();

    // Detect intent
    if (msg.match(/سلام|مرحبا|أهلا|bonjour|hello|hi/)) {
      return this.randomResponse('greeting');
    }
    if (msg.match(/سعر|ثمن|prix|price|كم|combien/)) {
      return this.randomResponse('price_inquiry').replace('{price}', '3,500');
    }
    if (msg.match(/شري|اشري|طلب|order|buy|acheter/)) {
      return this.randomResponse('order_confirm').replace('{orderId}', Math.random().toString(36).substring(2, 8).toUpperCase());
    }
    if (msg.match(/منتج|product|produit|شو عندك/)) {
      return this.randomResponse('product_inquiry');
    }

    return this.randomResponse('unknown');
  },

  randomResponse(type) {
    const arr = this.responses[type] || this.responses.unknown;
    return arr[Math.floor(Math.random() * arr.length)];
  }
};

// Export for use in other pages
window.Auth = Auth;
window.PointsSystem = PointsSystem;
window.FahimBot = FahimBot;
