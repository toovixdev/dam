/* TooVix DAM — shared auth helpers (theme bootstrap, password strength, OTP, demo nav). */
(function(){
  // apply saved theme so auth screens match the app
  var t = localStorage.getItem('nx-theme') || 'light';
  if(t === 'system') t = (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
})();

// theme flip in the form pane (so onboarding/login can match before app loads)
function nxToggleTheme(){
  var cur = document.documentElement.getAttribute('data-theme');
  var next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('nx-theme', next);
}

// password strength 0..4 -> width/colour
function nxStrength(v){
  var s = 0;
  if(v.length >= 8) s++;
  if(/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
  if(/\d/.test(v)) s++;
  if(/[^A-Za-z0-9]/.test(v)) s++;
  return Math.min(s, 4);
}
function nxWireStrength(input, bar, hint){
  var cols = ['#e11d48','#ea8a06','#ea8a06','#16a34a','#16a34a'];
  var lbl  = ['Too weak','Weak','Fair','Strong','Very strong'];
  function upd(){
    var s = nxStrength(input.value);
    bar.style.width = (input.value ? (s/4*100) : 0) + '%';
    bar.style.background = cols[s];
    if(hint) hint.textContent = input.value ? lbl[s] + ' password' : 'Min 8 chars, mixed case, a number & a symbol';
  }
  input.addEventListener('input', upd); upd();
}

// OTP: auto-advance + paste
function nxWireOtp(container, onComplete){
  var boxes = [].slice.call(container.querySelectorAll('input'));
  boxes.forEach(function(b, i){
    b.addEventListener('input', function(){
      b.value = b.value.replace(/\D/g,'').slice(-1);
      if(b.value && i < boxes.length-1) boxes[i+1].focus();
      if(boxes.every(function(x){return x.value;}) && onComplete) onComplete(boxes.map(function(x){return x.value;}).join(''));
    });
    b.addEventListener('keydown', function(e){
      if(e.key === 'Backspace' && !b.value && i>0) boxes[i-1].focus();
    });
    b.addEventListener('paste', function(e){
      var d = (e.clipboardData.getData('text')||'').replace(/\D/g,'').slice(0,boxes.length);
      if(!d) return; e.preventDefault();
      boxes.forEach(function(x,j){ x.value = d[j]||''; });
      (boxes[d.length] || boxes[boxes.length-1]).focus();
      if(d.length === boxes.length && onComplete) onComplete(d);
    });
  });
}

function nxGo(href){ location.href = href; }
