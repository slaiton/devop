-- Reglas concretas del proyecto en vez de un solo texto libre. Se guardan como arrays
-- (una regla por línea en el formulario) para poder referenciarlas individualmente.
ALTER TABLE project_profiles
  ADD COLUMN mandatory_rules text[] NOT NULL DEFAULT '{}',
  ADD COLUMN security_rules text[] NOT NULL DEFAULT '{}',
  ADD COLUMN conventions text[] NOT NULL DEFAULT '{}',
  ADD COLUMN migrations_policy text,
  ADD COLUMN compatibility_notes text;

-- Nuevas categorías para cubrir BD/regresiones explícitamente. Postgres no soporta
-- agregar valores a un CHECK existente sin reemplazarlo.
ALTER TABLE findings DROP CONSTRAINT findings_category_check;
ALTER TABLE findings ADD CONSTRAINT findings_category_check CHECK (
  category IN (
    'architecture', 'clean_code', 'solid', 'security', 'performance',
    'duplication', 'complexity', 'best_practice', 'documentation', 'test_coverage',
    'database', 'regression'
  )
);

-- A qué regla concreta del perfil del proyecto corresponde este finding (si aplica) —
-- permite listar "reglas incumplidas" con ubicación exacta reutilizando file_path/line.
ALTER TABLE findings ADD COLUMN violated_rule text;

-- Veredicto de 3 estados en vez de 2.
ALTER TABLE review_runs DROP CONSTRAINT review_runs_gate_decision_check;
ALTER TABLE review_runs ADD CONSTRAINT review_runs_gate_decision_check CHECK (
  gate_decision IN ('apto', 'requiere_revision', 'no_apto')
);

-- llm_verdict guarda lo que sugirió el modelo; gate_decision guarda el veredicto final
-- tras aplicar la regla dura determinista — permite auditar cuándo el código corrigió
-- al modelo.
ALTER TABLE review_runs
  ADD COLUMN llm_verdict text CHECK (llm_verdict IN ('apto', 'requiere_revision', 'no_apto')),
  ADD COLUMN final_justification text,
  ADD COLUMN commit_history_comparison text,
  ADD COLUMN recommendations text[],
  ADD COLUMN recommended_tests text[],
  ADD COLUMN analyzed_files text[];
