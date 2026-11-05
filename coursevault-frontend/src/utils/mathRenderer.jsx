import katex from 'katex';
import 'katex/dist/katex.min.css';
import { unicodeMathToLatex, isUnicodeMath } from './unicodeMath';

// ============================================
// ENHANCED CONVERTER - Handles all math types
// ============================================

/**
 * True when `text` is already LaTeX source rather than the loose
 * "unicode-ish maths" this converter is designed to normalise.
 *
 * This guard matters because convertToLatex is NOT idempotent: run it over
 * its own output and STEP 4 sees the "/" inside "\frac{a}{b}", STEP 10 wraps
 * the braces again, and the expression rots a little more on every keystroke.
 * Real LaTeX needs no conversion, so return it untouched.
 */
export function looksLikeLatex(text) {
  if (!text) return false;
  return (
    /\\(?:frac|dfrac|tfrac|int|iint|oint|sqrt|sum|prod|lim|left|right|begin|end|cdot|times|div|pm|mp|infty|partial|nabla|vec|hat|bar|binom|log|ln|sin|cos|tan|text|mathbb|mathcal|mathbf|alpha|beta|gamma|delta|theta|lambda|mu|sigma|phi|omega|pi|leq|geq|neq|approx|equiv|in|subset|cup|cap|forall|exists)\b/.test(
      text
    ) ||
    /\\[a-zA-Z]+\s*\{/.test(text) ||
    // Braced scripts are LaTeX even with no backslash in sight. Without this,
    // perfectly good output like "a_{11}A_{31}+a_{12}A_{32}" or "{|A|}^{2}"
    // falls through and gets re-processed into something worse.
    /[\^_]\{[^{}]*\}/.test(text)
  );
}

/**
 * Unicode that still needs mapping to a LaTeX command. Text can be *both*
 * partly LaTeX and still contain these (e.g. "∫_{a}^{b} x dx"), in which case
 * the early return must not fire or the ∫ would reach KaTeX unconverted.
 */
const NEEDS_CONVERSION =
  /[∫∬∭∮∑∏√×÷≤≥≠≈≡≅∝∞±∓∂∇∈∉⊂⊃⊆⊇∪∩∧∨¬∀∃∠⊥∥°⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΥΦΨΩ]/;

/**
 * A bare "/" between two operands is a fraction waiting to be stacked. Text
 * can look like LaTeX (braced scripts) and still contain one, so this has to
 * be checked separately or "(x^{3}-4)/x^{2}" would render as a slash rather
 * than a proper \frac.
 */
const HAS_SLASH_FRACTION = /[a-zA-Z\d})\]]\s*\/\s*[a-zA-Z\d\\({]/;

export function convertToLatex(text) {
  if (!text) return text;

  // Word's linear format needs a real scanner, not regexes — its ▒ / 〖〗
  // markers are structural and would otherwise survive into the output.
  if (isUnicodeMath(text)) {
    text = unicodeMathToLatex(text);
  }

  // Already LaTeX — converting again would corrupt it. Unless there is still
  // raw unicode maths in there that KaTeX would choke on.
  if (
    looksLikeLatex(text) &&
    !NEEDS_CONVERSION.test(text) &&
    !HAS_SLASH_FRACTION.test(text)
  ) {
    return String(text).trim();
  }

  let latex = text;

  // ============================================
  // STEP 0: Pre-processing - Clean up input
  // ============================================
  
  // Invisible operators first — U+2061 etc. have no KaTeX glyph and would
  // otherwise survive every rule below and reach the renderer intact.
  latex = latex.replace(INVISIBLE_CHARS, '');

  // Remove extra whitespace
  latex = latex.replace(/\s+/g, ' ').trim();

  // ============================================
  // STEP 1: Handle matrices
  // [[1,2],[3,4]] -> \begin{pmatrix}...\end{pmatrix}
  // ============================================
  latex = latex.replace(/\[\[([\s\S]+?)\]\]/g, (full, inner) => {
    const rows = inner
      .split(/\]\s*,\s*\[/)
      .map(row => row.replace(/^\[|\]$/g, ''))
      .map(row => row.split(',').map(cell => cell.trim()).join(' & '));
    return `\\begin{pmatrix}${rows.join(' \\\\ ')}\\end{pmatrix}`;
  });

  // ============================================
  // STEP 2: Handle square roots
  // √(expr) -> \sqrt{expr}
  // √123 -> \sqrt{123}
  // √x -> \sqrt{x}
  // ============================================
  latex = latex.replace(/√\(([^()]+)\)/g, '\\sqrt{$1}');
  latex = latex.replace(/√(\d+(?:\.\d+)?)/g, '\\sqrt{$1}');
  latex = latex.replace(/√([a-zA-Z])/g, '\\sqrt{$1}');

  // ============================================
  // STEP 3: Handle nth roots
  // ∛x -> \sqrt[3]{x}
  // ∜x -> \sqrt[4]{x}
  // ============================================
  latex = latex.replace(/∛/g, '\\sqrt[3]{}');
  latex = latex.replace(/∜/g, '\\sqrt[4]{}');

  // ============================================
  // STEP 4: Handle fractions
  // a/b -> \frac{a}{b}
  // (a+b)/(c+d) -> \frac{a+b}{c+d}
  // ============================================
  
  // One operand-aware rule replaces the four single-character rules that used
  // to live here. Those matched exactly one character on each side of the "/",
  // so a denominator carrying a script lost it:
  //
  //   (x^3 + 5x^2 - 4)/x^2  ->  \frac{x^3 + 5x^2 - 4}{x}^{2}
  //
  // The orphaned ^{2} then binds to the whole fraction and renders as
  // (…/x)² instead of …/x². An operand is therefore a group, a command or a
  // token *together with* any scripts hanging off it.
  // A brace group, allowing two levels of nesting — enough for "{x^{2}+2}"
  // and "\sqrt{a^{b^{c}}}". JS regex has no recursion, so the depth is fixed.
  const BRACE = String.raw`\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}`;

  // A command MUST swallow its brace arguments to count as one operand.
  // Without the (?:BRACE)* below, "1/\sqrt{x^2+2}" split as
  //   \frac{1}{\sqrt}{x^2+2}
  // leaving the radicand stranded outside the fraction — which is both wrong
  // and unbalanced once further rules touch it.
  // Greek is in the token class because fractions are resolved before the
  // symbol tables run, so "7π/6" is still literally "7π/6" at this point.
  // Without it the numerator matched only "7" and the fraction never formed.
  const TOKEN = String.raw`[a-zA-Z\d.Ͱ-Ͽ℀-⅏]+`;

  const OPERAND =
    String.raw`(?:\\[a-zA-Z]+(?:${BRACE})*|${BRACE}|\([^()]*\)|${TOKEN})` +
    String.raw`(?:[\^_](?:${BRACE}|\\[a-zA-Z]+(?:${BRACE})*|[a-zA-Z\d]))*`;

  // Parentheses that only existed to group a fraction operand are redundant
  // once it sits inside \frac{…}.
  const unwrap = (s) => {
    const t = s.trim();
    return /^\([^()]*\)$/.test(t) ? t.slice(1, -1).trim() : t;
  };

  latex = latex.replace(
    new RegExp(`(${OPERAND})\\s*/\\s*(${OPERAND})`, 'g'),
    (_, num, den) => `\\frac{${unwrap(num)}}{${unwrap(den)}}`
  );

  // ============================================
  // STEP 5: Handle superscripts and subscripts
  // ============================================
  const superscripts = {
    '⁰': '^{0}', '¹': '^{1}', '²': '^{2}', '³': '^{3}',
    '⁴': '^{4}', '⁵': '^{5}', '⁶': '^{6}', '⁷': '^{7}',
    '⁸': '^{8}', '⁹': '^{9}', '⁺': '^{+}', '⁻': '^{-}',
    '⁼': '^{=}', '⁽': '^{(}', '⁾': '^{)}', 'ⁿ': '^{n}'
  };
  
  const subscripts = {
    '₀': '_{0}', '₁': '_{1}', '₂': '_{2}', '₃': '_{3}',
    '₄': '_{4}', '₅': '_{5}', '₆': '_{6}', '₇': '_{7}',
    '₈': '_{8}', '₉': '_{9}', '₊': '_{+}', '₋': '_{-}',
    '₌': '_{=}', '₍': '_{(}', '₎': '_{)}'
  };

  // Convert superscripts
  Object.entries(superscripts).forEach(([word, latexCmd]) => {
    latex = latex.replaceAll(word, latexCmd);
  });
  
  // Convert subscripts
  Object.entries(subscripts).forEach(([word, latexCmd]) => {
    latex = latex.replaceAll(word, latexCmd);
  });

  // Word-style ^ notation
  latex = latex.replace(/([a-zA-Z\d])\^(\d+)/g, '$1^{$2}');
  latex = latex.replace(/([a-zA-Z\d])\^([a-zA-Z])/g, '$1^{$2}');
  latex = latex.replace(/\^(\d+)/g, '^{$1}');
  latex = latex.replace(/\^([a-zA-Z])/g, '^{$1}');

  // Word-style _ notation
  latex = latex.replace(/([a-zA-Z\d])_(\d+)/g, '$1_{$2}');
  latex = latex.replace(/([a-zA-Z\d])_([a-zA-Z])/g, '$1_{$2}');

  // Parenthesised script arguments: x^(n+1) -> x^{n+1}, ∫_(-a)^(a) -> ∫_{-a}^{a}
  //
  // This must run before STEP 10 turns "(" into "\left(", because a script
  // argument of more than one token MUST be braced — "_\left( a \right)" is a
  // LaTeX syntax error, and it is what Word's linear format produces.
  for (let pass = 0; pass < 3; pass++) {
    latex = latex.replace(/([_^])\s*\(([^()]*)\)/g, '$1{$2}');
  }

  // ============================================
  // STEP 6: Handle integrals and derivatives
  // ∫ x dx -> \int x \, dx
  // ∫_a^b x dx -> \int_{a}^{b} x \, dx
  // ============================================
  // A trailing space is required: "∫x" must become "\int x", not "\intx"
  // (which KaTeX reads as the undefined control sequence \intx). The lookahead
  // keeps limits tight, so "∫_a^b" still yields "\int_a^b".
  latex = latex.replace(/∫(?![_^])/g, '\\int ');
  latex = latex.replace(/∬(?![_^])/g, '\\iint ');
  latex = latex.replace(/∭(?![_^])/g, '\\iiint ');
  latex = latex.replace(/∮(?![_^])/g, '\\oint ');
  latex = latex.replace(/∫/g, '\\int');
  latex = latex.replace(/∬/g, '\\iint');
  latex = latex.replace(/∭/g, '\\iiint');
  latex = latex.replace(/∮/g, '\\oint');
  
  // Add differential d
  latex = latex.replace(/\\int\s+([^d]*?)\s+d([a-zA-Z])/g, '\\int $1 \\, d$2');
  
  // Integrals with limits
  latex = latex.replace(/∫_([^{])([^}]*?)\^([^{])([^}]*?)/g, '\\int_{$1$2}^{$3$4}');
  latex = latex.replace(/∫_\{([^}]*?)\}\^\{([^}]*?)\}/g, '\\int_{$1}^{$2}');

  // ============================================
  // STEP 7: Handle vectors
  // ->a or \vec{a} -> \vec{a}
  // ============================================
  latex = latex.replace(/->([a-zA-Z])/g, '\\vec{$1}');
  latex = latex.replace(/\\vec\{([^}]*?)\}/g, '\\vec{$1}');
  
  // Vector with arrow
  latex = latex.replace(/→([a-zA-Z])/g, '\\vec{$1}');
  
  // Bold vectors
  latex = latex.replace(/\\mathbf\{([^}]*?)\}/g, '\\mathbf{$1}');

  // ============================================
  // STEP 8: Math symbols
  // ============================================
  const mathSymbols = {
    '×': ' \\times ',
    '÷': ' \\div ',
    '∑': '\\sum ',
    '∏': '\\prod ',
    'π': '\\pi ',
    'α': '\\alpha ',
    'β': '\\beta ',
    'γ': '\\gamma ',
    'δ': '\\delta ',
    'ε': '\\epsilon ',
    'ζ': '\\zeta ',
    'η': '\\eta ',
    'θ': '\\theta ',
    'ι': '\\iota ',
    'κ': '\\kappa ',
    'λ': '\\lambda ',
    'μ': '\\mu ',
    'ν': '\\nu ',
    'ξ': '\\xi ',
    'ο': '\\omicron ',
    'π': '\\pi ',
    'ρ': '\\rho ',
    'σ': '\\sigma ',
    'τ': '\\tau ',
    'υ': '\\upsilon ',
    'φ': '\\phi ',
    'χ': '\\chi ',
    'ψ': '\\psi ',
    'ω': '\\omega ',
    'Α': '\\Alpha ',
    'Β': '\\Beta ',
    'Γ': '\\Gamma ',
    'Δ': '\\Delta ',
    'Ε': '\\Epsilon ',
    'Ζ': '\\Zeta ',
    'Η': '\\Eta ',
    'Θ': '\\Theta ',
    'Ι': '\\Iota ',
    'Κ': '\\Kappa ',
    'Λ': '\\Lambda ',
    'Μ': '\\Mu ',
    'Ν': '\\Nu ',
    'Ξ': '\\Xi ',
    'Ο': '\\Omicron ',
    'Π': '\\Pi ',
    'Ρ': '\\Rho ',
    'Σ': '\\Sigma ',
    'Τ': '\\Tau ',
    'Υ': '\\Upsilon ',
    'Φ': '\\Phi ',
    'Χ': '\\Chi ',
    'Ψ': '\\Psi ',
    'Ω': '\\Omega ',
    '≤': '\\leq ',
    '≥': '\\geq ',
    '≠': '\\neq ',
    '≈': '\\approx ',
    '≡': '\\equiv ',
    '≅': '\\cong ',
    '∝': '\\propto ',
    '∞': '\\infty ',
    '±': '\\pm ',
    '∓': '\\mp ',
    '∂': '\\partial ',
    '∇': '\\nabla ',
    '∈': '\\in ',
    '∉': '\\notin ',
    '⊂': '\\subset ',
    '⊃': '\\supset ',
    '⊆': '\\subseteq ',
    '⊇': '\\supseteq ',
    '∪': '\\cup ',
    '∩': '\\cap ',
    '∧': '\\land ',
    '∨': '\\lor ',
    '¬': '\\neg ',
    '∀': '\\forall ',
    '∃': '\\exists ',
    '∠': '\\angle ',
    '⊥': '\\perp ',
    '∥': '\\parallel ',
    '∡': '\\measuredangle ',
    '□': '\\square ',
    'ℵ': '\\aleph ',
    'ℏ': '\\hbar ',
    'ℜ': '\\Re ',
    'ℑ': '\\Im ',
    'ℓ': '\\ell ',
    'ℱ': '\\mathcal{F}',
    'ℒ': '\\mathcal{L}',
    'ℋ': '\\mathcal{H}'
  };
  
  Object.entries(mathSymbols).forEach(([word, latexCmd]) => {
    latex = latex.replaceAll(word, latexCmd);
  });

  // ============================================
  // STEP 9: Handle absolute value and norms
  // |x| -> \left|x\right|
  // ||x|| -> \left\|x\right\|
  // ============================================
  latex = latex.replace(/\|\|([^|]*?)\|\|/g, '\\left\\| $1 \\right\\|');
  latex = latex.replace(/\|([^|]*?)\|/g, '\\left| $1 \\right|');

  // ============================================
  // STEP 10: Handle brackets
  // (a+b) -> \left(a+b\right)
  // [a+b] -> \left[a+b\right]
  // {a+b} -> \left\{a+b\right\}
  // ============================================
  // Scanner-based so \left and \right can never end up in different groups.
  latex = wrapDelimiters(latex);

  // ============================================
  // STEP 11: Handle binomial coefficients
  // C(n,k) -> \binom{n}{k}
  // ============================================
  latex = latex.replace(/C\(([^,]+),\s*([^)]+)\)/g, '\\binom{$1}{$2}');

  // ============================================
  // STEP 12: Handle derivatives
  // d/dx -> \frac{d}{dx}
  // d^2/dx^2 -> \frac{d^2}{dx^2}
  // ============================================
  latex = latex.replace(/d(\d*)\/d([a-zA-Z])(\d*)/g, (match, num1, var1, num2) => {
    if (num1 === '' && num2 === '') {
      return `\\frac{d}{d${var1}}`;
    } else if (num1 !== '' && num2 === '') {
      return `\\frac{d^{${num1}}}{d${var1}}`;
    } else if (num1 === '' && num2 !== '') {
      return `\\frac{d}{d${var1}^{${num2}}}`;
    } else {
      return `\\frac{d^{${num1}}}{d${var1}^{${num2}}}`;
    }
  });

  // ============================================
  // STEP 13: Handle trig functions
  // sin, cos, tan, etc.
  // ============================================
  const trigFunctions = [
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
    'sinh', 'cosh', 'tanh', 'coth',
    'arcsin', 'arccos', 'arctan', 'arccot', 'arcsec', 'arccsc'
  ];
  
  // The backslash in the lookbehind matters: without it, an already-converted
  // "\cos" matches on its bare "cos" and becomes "\\cos" — a line break in
  // LaTeX, not a cosine.
  trigFunctions.forEach(func => {
    latex = latex.replace(new RegExp(`(?<![a-zA-Z\\\\])${func}(?![a-zA-Z])`, 'g'), `\\${func} `);
  });

  // ============================================
  // STEP 14: Handle logarithms
  // log, ln, lg
  // ============================================
  latex = latex.replace(/(?<![a-zA-Z\\])log(?![a-zA-Z])/g, '\\log ');
  latex = latex.replace(/(?<![a-zA-Z\\])ln(?![a-zA-Z])/g, '\\ln ');
  latex = latex.replace(/(?<![a-zA-Z\\])lg(?![a-zA-Z])/g, '\\log_{10} ');

  // ============================================
  // STEP 15: Handle limits
  // lim -> \lim
  // ============================================
  latex = latex.replace(/(?<![a-zA-Z\\])lim(?![a-zA-Z])/g, '\\lim ');

  // ============================================
  // STEP 16: Handle scientific notation
  // 1.2e3 -> 1.2 \times 10^{3}
  // ============================================
  latex = latex.replace(/(\d+\.?\d*)e([+-]?\d+)/g, '$1 \\times 10^{$2}');

  // ============================================
  // STEP 17: Handle degree symbols
  // 45° -> 45^\circ
  // ============================================
  latex = latex.replace(/°(?![a-zA-Z])/g, '^\\circ ');

  // ============================================
  // STEP 18: Clean up spacing
  // ============================================
  // Remove extra spaces around operators but keep needed spaces
  latex = latex.replace(/\s*=\s*/g, ' = ');
  latex = latex.replace(/\s*\+\s*/g, ' + ');
  latex = latex.replace(/\s*-\s*/g, ' - ');
  latex = latex.replace(/\s*\*\s*/g, ' \\cdot ');
  
  // Remove double spaces
  latex = latex.replace(/\s{2,}/g, ' ');
  
  // Clean up \, spacing for differentials
  latex = latex.replace(/\\,\s+/g, '\\,');
  
  // Clean up \left and \right spacing
  latex = latex.replace(/\\left\s+/g, '\\left');
  latex = latex.replace(/\\right\s+/g, '\\right');

  // ============================================
  // STEP 19: Final polish
  // ============================================
  // Fix common issues
  latex = latex.replace(/\{\s+/g, '{');
  latex = latex.replace(/\s+\}/g, '}');
  latex = latex.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '\\frac{$1}{$2}');
  
  // Trim final result
  latex = latex.trim();

  // Safety net. Every rule above is a regex over text it does not fully
  // understand, so a future edit can always drop or strand a brace — and
  // unbalanced LaTeX is what KaTeX prints in red. If we broke a balanced
  // input, hand back the input: imperfect rendering beats an error message.
  if (braceBalance(latex) !== 0 && braceBalance(text) === 0) {
    if (typeof console !== 'undefined') {
      console.warn('[mathRenderer] conversion unbalanced braces; keeping original', {
        input: text,
        output: latex,
      });
    }
    return String(text).trim();
  }

  return latex;
}

/**
 * Characters that carry no visual meaning and have no KaTeX glyph. Word emits
 * U+2061 FUNCTION APPLICATION between a function name and its argument, which
 * is why "cos⁡(x)" arrives with an invisible character wedged in the middle.
 */
const INVISIBLE_CHARS = /[⁡-⁤​-‍﻿­]/g;

/**
 * Wrap matched ( ) and [ ] pairs in \left … \right.
 *
 * Done with a scanner rather than a regex because \left and \right must be in
 * the *same brace group*. The old rule matched innermost pairs only, so with
 * nesting — or with a brace boundary between the two halves — it emitted
 * things like "\left( \cos {7\pi/6 \right)}", where \right) is stranded inside
 * a group and KaTeX reports an unmatched \left.
 *
 * A pair is wrapped only when both halves sit at the same brace depth; any
 * pair that doesn't is left as a plain parenthesis, which always renders.
 */
export function wrapDelimiters(input) {
  const s = String(input);
  const stack = [];
  const pairs = [];
  let brace = 0;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (c === '\\') {
      const cmd = s.slice(i).match(/^\\[a-zA-Z]+/);
      if (cmd) {
        i += cmd[0].length - 1;
        // \left and \right own the delimiter that follows them.
        if (cmd[0] === '\\left' || cmd[0] === '\\right') {
          let j = i + 1;
          while (j < s.length && /\s/.test(s[j])) j++;
          i = j;
        }
      } else {
        i++; // an escaped literal such as \{ or \$
      }
      continue;
    }

    if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === '(' || c === '[') stack.push({ index: i, char: c, brace });
    else if (c === ')' || c === ']') {
      const open = stack.pop();
      if (!open) continue;
      const matches = (open.char === '(' && c === ')') || (open.char === '[' && c === ']');
      if (matches && open.brace === brace) pairs.push([open.index, i]);
    }
  }

  if (pairs.length === 0) return s;

  const openAt = new Set(pairs.map((p) => p[0]));
  const closeAt = new Set(pairs.map((p) => p[1]));

  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (openAt.has(i)) out += `\\left${s[i]}`;
    else if (closeAt.has(i)) out += `\\right${s[i]}`;
    else out += s[i];
  }
  return out;
}

/**
 * Are every \left and \right correctly paired at the same brace depth?
 * KaTeX treats a violation as fatal, which is what renders as red text.
 */
function leftRightIsSound(s) {
  const stack = [];
  let brace = 0;

  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') {
      if (s[i] === '{') brace++;
      else if (s[i] === '}') brace--;
      continue;
    }
    const cmd = s.slice(i).match(/^\\(left|right|[a-zA-Z]+)/);
    if (!cmd) {
      i++;
      continue;
    }
    i += cmd[0].length - 1;
    if (cmd[1] === 'left') stack.push(brace);
    else if (cmd[1] === 'right') {
      if (stack.length === 0) return false;
      if (stack.pop() !== brace) return false;
    }
  }
  return stack.length === 0;
}

/** Remove every \left / \right, keeping the delimiters themselves. */
function demoteLeftRight(s) {
  return s.replace(/\\(?:left|right)\s*(?=[([{|.\\\])}])/g, '');
}

/**
 * Make any LaTeX string safe to hand to KaTeX.
 *
 * This is the universal net. The converter is a stack of regexes over
 * partially-transformed text, and content saved before a given fix stays
 * broken in the database forever — so rather than chasing each new symptom,
 * anything structurally invalid gets repaired here, immediately before render.
 */
export function repairLatex(input) {
  let s = String(input || '');

  // Invisible operators have no glyph and no meaning.
  s = s.replace(INVISIBLE_CHARS, '');

  // "\\cos" is a line break followed by letters, never a cosine.
  s = s.replace(/\\{2,}(?=[a-zA-Z])/g, '\\');

  // A \left that cannot find its \right is fatal; plain delimiters never are.
  if (!leftRightIsSound(s)) s = demoteLeftRight(s);

  // Close anything left open, drop anything closed too many times.
  let depth = braceBalance(s);
  if (depth > 0) s += '}'.repeat(depth);
  while (depth < 0) {
    s = s.replace(/\}(?![\s\S]*\})/, '');
    depth++;
  }

  return s.trim();
}

/** Net brace depth; 0 means balanced. Ignores escaped \{ and \}. */
export function braceBalance(text) {
  if (!text) return 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++; // skip the escaped character
      continue;
    }
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
  }
  return depth;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

export function isMathText(text) {
  if (!text) return false;
  
  const mathPatterns = [
    /[×÷√∫∑∏π∂∇∈∉⊂⊃∪∩∧∨¬∀∃∠⊥∥≤≥≠≈∞±]/,
    /[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/,
    /[αβγδεζηθικλμνξπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ]/,
    /\^|_/,
    /\|/,
    /\[\[[\s\S]+\]\]/,
    /[a-zA-Z]\^/,
    /[a-zA-Z]_/,
    /\\[a-zA-Z]+/,
    /[=≠≤≥≈∝≡≅]/
  ];
  
  return mathPatterns.some(pattern => pattern.test(text));
}

const KATEX_OPTIONS = {
  trust: true,
  macros: {
    "\\R": "\\mathbb{R}",
    "\\N": "\\mathbb{N}",
    "\\Z": "\\mathbb{Z}",
    "\\Q": "\\mathbb{Q}",
    "\\C": "\\mathbb{C}"
  }
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render with a ladder of fallbacks, so a bad string degrades instead of
 * turning into red error text:
 *
 *   1. the converted LaTeX
 *   2. the same, structurally repaired
 *   3. the raw input, repaired  (in case conversion was what broke it)
 *   4. plain escaped text       (readable, never red)
 *
 * `throwOnError` is true for attempts 1-3 specifically so failures fall
 * through to the next rung rather than being rendered in red on the spot.
 */
export function renderMath(text, displayMode = false) {
  if (!text) return text;

  const attempts = [];
  const converted = convertToLatex(text);
  attempts.push(converted);

  const repaired = repairLatex(converted);
  if (repaired !== converted) attempts.push(repaired);

  const rawRepaired = repairLatex(text);
  if (!attempts.includes(rawRepaired)) attempts.push(rawRepaired);

  for (const candidate of attempts) {
    try {
      return katex.renderToString(candidate, {
        ...KATEX_OPTIONS,
        throwOnError: true,
        displayMode,
      });
    } catch {
      /* try the next rung */
    }
  }

  if (typeof console !== 'undefined') {
    console.warn('[mathRenderer] could not render; showing plain text', {
      input: text,
      converted,
    });
  }
  return `<span class="math-fallback">${escapeHtml(text)}</span>`;
}

export function renderMathPreview(text) {
  return renderMath(text, false);
}

/**
 * Render a string that may be pure math OR prose containing `$…$` islands.
 * A mixed paste ("Evaluate $\int x^2\,dx$ and simplify") must not be shoved
 * through KaTeX wholesale, or the prose becomes italic maths variables.
 */
/**
 * Is this token a piece of maths rather than a word?
 *
 * Used to keep prose out of math mode. In math mode LaTeX drops spaces and
 * italicises every letter as a variable, so "The principle value of" renders
 * as "Theprinciplevalueof" — which is what happens when a whole sentence is
 * handed to KaTeX because it happens to contain a backslash somewhere.
 */
function isMathToken(token) {
  if (!token) return false;
  const t = token.replace(/[.,:;?!]+$/, '');
  if (!t) return false;

  if (/\\/.test(t)) return true; // any LaTeX command
  if (/[\^_]/.test(t)) return true; // scripts
  if (/[∫∬∮∑∏√∞±×÷≤≥≠≈≡∈∉⊂⊆∪∩∀∃∠⊥°π]/.test(t)) return true;
  if (/^[(){}[\]|]+$/.test(t)) return true; // lone delimiters
  if (/^[+\-*/=<>]+$/.test(t)) return true; // lone operators
  // Do not automatically treat standalone numbers as mathematical expressions.
  // Numbers will be classified as math contextually inside renderProseWithMath().
  return false;
}

/**
 * Tokens that are maths *inside* an expression but ordinary words on their
 * own. A lone "a" is the English article far more often than it is a variable,
 * so it only counts as maths when an expression is already open — otherwise
 * "is a number associated to a square matrix" picks up two italic variables.
 */
function isNeutralToken(token) {
  const t = token.replace(/[.,:;?!]+$/, '');
  return /^[A-Za-z]$/.test(t) || /^[A-Za-z][\d'’]$/.test(t);
}

/**
 * Render a sentence that mixes prose and maths but has no $…$ markers.
 * Consecutive maths tokens are grouped so multi-token expressions such as
 * "\left( -\frac{1}{2} \right)" render as one unit.
 */
function renderProseWithMath(text) {
  const tokens = String(text).split(/(\s+)/);
  let out = '';
  let buffer = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const expr = buffer.join(' ').trim();
    out += expr ? renderMath(expr, false) : '';
    buffer = [];
  };

  // An expression with an unclosed brace or a \left still awaiting its \right
  // must keep absorbing tokens, or "\left| adj A \right|" is torn in three at
  // the word "adj" and the delimiters end up unpaired.
  const bufferIsOpen = () => {
    if (buffer.length === 0) return false;
    const joined = buffer.join(' ');
    return braceBalance(joined) !== 0 || !leftRightIsSound(joined);
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (/^\s+$/.test(token)) {
      if (buffer.length === 0) out += token;
      continue;
    }

    const isNumericToken = /^\d+(?:[.,]\d+)*[.,:;?!]*$/.test(token);

    let nextIndex = i + 1;
    while (nextIndex < tokens.length && /^\s+$/.test(tokens[nextIndex])) {
      nextIndex++;
    }

    const nextToken = tokens[nextIndex] || '';

    const isNumericMath =
      isNumericToken &&
      (
        buffer.length > 0 ||
        /^[+\-*/=<>×÷^]/.test(nextToken)
      );

    if (
      bufferIsOpen() ||
      isMathToken(token) ||
      isNumericMath ||
      (buffer.length > 0 && isNeutralToken(token))
    ) {
      buffer.push(token);
      continue;
    }

    if (buffer.length) {
      flush();
      out += ' ';
    }
    out += escapeHtml(token) + ' ';
  }
  flush();

  return out.replace(/\s+$/, '');
}

/** Two or more ordinary words means this is a sentence, not an expression. */
function looksLikeProse(text) {
  const words = String(text)
    .split(/\s+/)
    .filter((t) => !isMathToken(t) && /[A-Za-z]{2,}/.test(t));
  return words.length >= 2;
}

export function renderMixed(text) {
  if (!text) return '';

  if (!/\$/.test(text)) {
    return looksLikeProse(text) ? renderProseWithMath(text) : renderMath(text, false);
  }

  const pattern = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let out = '';
  let lastIndex = 0;
  let match;

  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out += escapeHtml(text.slice(lastIndex, match.index));
    }
    const isBlock = match[1] !== undefined;
    out += renderMath(isBlock ? match[1] : match[2], isBlock);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) out += escapeHtml(text.slice(lastIndex));

  return out;
}

export function renderDisplayMath(text) {
  return renderMath(text, true);
}

export function getPlainText(text) {
  if (!text) return text;
  
  let plain = text
    .replace(/\\[a-zA-Z]+(?:\s|$)/g, '')
    .replace(/\^\{[^}]*\}/g, '')
    .replace(/_{[^}]*}/g, '')
    .replace(/\\left\|/g, '|')
    .replace(/\\right\|/g, '|')
    .replace(/\\begin\{[^}]*\}/g, '')
    .replace(/\\end\{[^}]*\}/g, '')
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '$1/$2')
    .replace(/\\cdot/g, '*')
    .replace(/\\div/g, '/')
    .replace(/\\times/g, '×');
  
  return plain;
}

export function isPureMath(text) {
  if (!text) return false;
  
  const mathCount = (text.match(/[×÷√∫∑π≤≥≠≈∞±αβγδθλμσφω]/g) || []).length;
  const superscriptCount = (text.match(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g) || []).length;
  const subscriptCount = (text.match(/[₀₁₂₃₄₅₆₇₈₉]/g) || []).length;
  const wordCount = (text.match(/[a-zA-Z]{3,}/g) || []).length;
  
  return (mathCount + superscriptCount + subscriptCount) > wordCount;
}

export function extractLatex(text) {
  if (!text) return '';
  return convertToLatex(text);
}

// ============================================
// MATH TEXT COMPONENT
// ============================================

import React, { useMemo } from 'react';

function splitSegments(text) {
  if (!text) return [];
  const pattern = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  const segments = [];
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      segments.push({ type: 'block', value: match[1] });
    } else {
      segments.push({ type: 'inline', value: match[2] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}

function renderKatex(value, displayMode) {
  try {
    const latex = convertToLatex(value);
    return katex.renderToString(latex, {
      throwOnError: false,
      displayMode: displayMode,
      trust: true,
      macros: {
        "\\R": "\\mathbb{R}",
        "\\N": "\\mathbb{N}",
        "\\Z": "\\mathbb{Z}",
        "\\Q": "\\mathbb{Q}",
        "\\C": "\\mathbb{C}"
      }
    });
  } catch (e) {
    console.log('KaTeX render error:', e);
    return value;
  }
}

export default function MathText({ text, className = '' }) {
  const segments = useMemo(() => splitSegments(text || ''), [text]);

  if (segments.length === 0) return null;

  return (
    <span className={className}>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return seg.value.split('\n').map((line, j) => (
            <React.Fragment key={`${i}-${j}`}>
              {j > 0 && <br />}
              {line}
            </React.Fragment>
          ));
        }
        const html = renderKatex(seg.value, seg.type === 'block');
        return seg.type === 'block' ? (
          <div key={i} className="my-2 overflow-x-auto text-center" 
               dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <span key={i} dangerouslySetInnerHTML={{ __html: html }} />
        );
      })}
    </span>
  );
}

// ============================================
// ADDITIONAL EXPORTS FOR COMPLEX MATH
// ============================================

// Export a function to handle multi-line equations
export function renderMultiLineMath(text) {
  if (!text) return '';
  
  // Split by new lines
  const lines = text.split('\n').filter(line => line.trim());
  
  // Wrap in align environment for multi-line
  if (lines.length > 1) {
    const aligned = lines.map(line => {
      // Check if line contains equals sign for alignment
      if (line.includes('=')) {
        const parts = line.split('=').map(p => p.trim());
        return `${parts[0]} &= ${parts.slice(1).join(' = ')}`;
      }
      return line.trim();
    }).join(' \\\\ ');
    
    return renderDisplayMath(`\\begin{aligned} ${aligned} \\end{aligned}`);
  }
  
  return renderMath(text);
}

// Export a function to handle cases/conditional equations
export function renderCasesMath(text) {
  if (!text) return '';
  
  // Detect and handle cases
  const casesRegex = /\{([^}]*?)\s*,\s*([^}]*?)\s*,\s*([^}]*?)\s*\}/;
  const match = text.match(casesRegex);
  
  if (match) {
    const conditions = match.slice(1).map(c => c.trim());
    const casesLatex = conditions.map((condition, index) => {
      return `${condition} & \\text{if } ${index === 0 ? 'condition 1' : `condition ${index + 1}`}`;
    }).join(' \\\\ ');
    return renderDisplayMath(`\\begin{cases} ${casesLatex} \\end{cases}`);
  }
  
  return renderMath(text);
}
