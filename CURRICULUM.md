# Schola: six months of applied machine learning

This plan contains 26 weeks at 10–12 hours per week. The working estimate is 286 hours.

The plan uses soccer prediction to connect mathematics, models, experiments, and engineering evidence.
It assumes professional software experience, rusty algebra, and no prior calculus.
Completion measures demonstrated skills. It does not award a degree or guarantee employment.

Each week reserves 6 hours for building, 3 hours for mathematics, and 2 hours for evidence or reflection.
At 10 hours, shorten optional reading. At 12 hours, use the extra hour for review.
If a foundation needs more time, move optional attention training to the next phase.

Use AI agents as tutors and reviewers. Predict the result before running generated code.
Complete the independent challenge yourself, then use an agent to critique your explanation.
Never mark a module complete from generated work alone.

## Learning path

### Weeks 1–2: Start with a forecast

Build a reproducible match table and a baseline: a simple reference prediction.

Refresh fractions, ratios, percentages, means, variables, functions, and summation through match statistics.

1. Load historical matches. Record the source, download date, license, and a small data dictionary.
2. Create chronological training, validation, and untouched test sets. Count missing and duplicate rows.
3. Predict home/draw/away using training-set frequencies. Compute accuracy and Brier score, the squared error of probabilities.
4. Explain why a post-match statistic leaks the answer into a pre-match forecast. Record your baseline and evidence.

Data: StatsBomb Open Data: competitions.json → matches/{competition_id}/{season_id}.json. Use scores, dates, and information available before kickoff. Build recent-form features only from earlier matches.

Evidence: A runnable baseline, a data dictionary, split dates, and a one-page explanation of what the model knows before kickoff.

Independent challenge: Recompute a three-outcome Brier score for one match. Explain why all three probabilities must sum to one.

Reading: ISL chapter 2. Use a small competition first. Preserve the same held-out test period throughout the project.

- [StatsBomb Open Data](https://github.com/hudl/open-data)
- [An Introduction to Statistical Learning · Python](https://www.statlearning.com/)

### Weeks 3–4: Make the mathematics visible

Build a small interactive forecast with adjustable weights for recent form and home advantage.

Refresh equations, slopes, powers, exponentials, logarithms, function composition, and coordinate plots.

1. Plot a weighted score as you vary each input. Label the units and ranges.
2. Convert scores to three probabilities with softmax, a function that turns scores into normalized probabilities.
3. Plot squared error and log loss as predictions become confidently wrong. Recreate one calculation without a model library.
4. Write what each symbol means and translate the formula into a small Python function.

Data: StatsBomb Open Data: competitions.json → matches/{competition_id}/{season_id}.json. Use scores, dates, and information available before kickoff. Build recent-form features only from earlier matches.

Evidence: A notebook with adjustable inputs, labeled plots, and examples of confident errors.

Independent challenge: Explain why a tiny probability for the actual outcome produces a large log loss. Calculate one example.

Reading: ISL chapters 2 and 4. Use logarithms as measurements of multiplicative change.

- [3Blue1Brown · visual mathematics](https://www.3blue1brown.com/)
- [An Introduction to Statistical Learning · Python](https://www.statlearning.com/)

### Weeks 5–6: Think in vectors

Implement batched predictions with NumPy and build a player similarity explorer.

Learn vectors, matrix shapes, dot products, norms, projections, rank, and feature scaling.

1. Represent matches as rows and pre-match measurements as columns. Annotate every matrix shape.
2. Compute one prediction with a loop and with a matrix product. Make sure that the results agree.
3. Build a player similarity search with normalized vectors. Show how scaling changes the neighbors.
4. Demonstrate redundant columns and explain why they create estimation problems.

Data: StatsBomb Open Data: competitions.json → matches/{competition_id}/{season_id}.json. Use scores, dates, and information available before kickoff. Build recent-form features only from earlier matches. Player similarity uses player statistics aggregated from event files; restrict these to training matches.

Evidence: A matrix implementation with numerical comparisons and a similarity example whose behavior you can explain.

Independent challenge: Calculate a small dot product yourself. Diagnose a shape error and explain one misleading similarity result.

Reading: Mathematics for Machine Learning chapters 2 and 3. Read only the sections used by the experiments.

- [Mathematics for Machine Learning](https://mml-book.github.io/)
- [3Blue1Brown · visual mathematics](https://www.3blue1brown.com/)

### Weeks 7–8: Learn from error

Fit a linear model from scratch and compare it with a library implementation.

Learn limits through finite differences, derivatives, partial derivatives, gradients, and the chain rule.

1. Plot an error curve. Estimate its slope with small input changes before using a derivative formula.
2. Derive the squared-error gradient for a linear model and implement gradient descent.
3. Compare analytic gradients with finite differences. Try several learning rates and explain divergence.
4. Fit a reference library model and compare predictions, training curves, and numerical stability.

Data: StatsBomb Open Data: competitions.json → matches/{competition_id}/{season_id}.json. Use scores, dates, and information available before kickoff. Build recent-form features only from earlier matches.

Evidence: A working training loop, gradient comparison, learning curves, and a written explanation of a failed learning rate.

Independent challenge: Derive one weight update, compute it on a tiny example, and explain how the loss changes.

Reading: Mathematics for Machine Learning chapters 5 and 7. D2L calculus and linear regression sections.

- [Mathematics for Machine Learning](https://mml-book.github.io/)
- [Dive into Deep Learning](https://d2l.ai/)
- [3Blue1Brown · visual mathematics](https://www.3blue1brown.com/)

### Weeks 9–10: Predict goals and uncertainty

Build a Poisson goal model and simulate scorelines and season outcomes.

Learn random variables, conditional probability, independence, expectation, variance, likelihood, and numerical integration.

1. Estimate goal rates using training data and plot a Poisson distribution, a model for event counts.
2. Simulate scorelines and derive home/draw/away probabilities. Account for truncated probability mass.
3. Compare forecasts with the baseline. Explain when independent goal counts are a poor assumption.
4. Resample matches to estimate uncertainty. Distinguish outcome uncertainty from uncertainty in estimated performance.

Data: StatsBomb Open Data: competitions.json → matches/{competition_id}/{season_id}.json. Use scores, dates, and information available before kickoff. Build recent-form features only from earlier matches.

Evidence: A goal model, a scoreline simulator, and an evaluation with uncertainty and stated assumptions.

Independent challenge: Explain why a 70% forecast can lose. Calculate conditional probability on a small match table.

Reading: Mathematics for Machine Learning chapter 6. Use simulation before formal probability notation.

- [Mathematics for Machine Learning](https://mml-book.github.io/)
- [An Introduction to Statistical Learning · Python](https://www.statlearning.com/)

### Weeks 11–12: Build expected goals

Train logistic regression to estimate expected goals: the scoring probability of a shot.

Learn distance and angle geometry, sigmoid, log likelihood, regularization, and probability calibration.

1. Extract shots and outcomes. Compute distance and angle to goal from pitch coordinates.
2. Split by match and date so shots from one match cannot cross partitions. Fit preprocessing on training data only.
3. Implement a small logistic model and compare it with a library model. Tune regularization on validation data.
4. Compare log loss and Brier score with a constant baseline. Plot calibration, the agreement between predicted and observed frequencies.

Data: StatsBomb Open Data: events/{match_id}.json joined to match dates. For shots, use shot locations and outcomes. Split by whole match and date.

Evidence: An expected-goals model with grouped chronological splits, calibration plots, and a baseline comparison.

Independent challenge: Explain why shot outcome is a target and provider expected-goals values are excluded from your input features.

Reading: ISL chapters 4 and 6. Keep vendor expected-goals estimates out of the training features.

- [StatsBomb Open Data](https://github.com/hudl/open-data)
- [An Introduction to Statistical Learning · Python](https://www.statlearning.com/)

### Weeks 13–14: Run fair comparisons

Compare trees and boosting with your linear and logistic models.

Learn bias and variance, resampling, generalization, and regularization through model comparisons.

1. Train a decision tree and a boosted tree model on the same task and partitions.
2. Run a small declared parameter search with chronological validation folds. Keep preprocessing inside each fold.
3. Record at least three controlled experiments. Change one design choice in each experiment.
4. Compare quality, runtime, and stability. Explain an overfit model and one result that contradicts your expectation.

Data: StatsBomb Open Data: events/{match_id}.json joined to match dates. For shots, use shot locations and outcomes. Split by whole match and date.

Evidence: A reproducible comparison of at least three model families and three experiments with explicit hypotheses.

Independent challenge: Explain why selecting a model using test scores invalidates the final test. Repair a deliberately flawed evaluation.

Reading: ISL chapters 5, 6, and 8. Prefer small searches with clear questions over large parameter sweeps.

- [An Introduction to Statistical Learning · Python](https://www.statlearning.com/)

### Weeks 15–16: Build a neural network

Train a small PyTorch network for the shot prediction task.

Apply the chain rule to backpropagation, the calculation of gradients through a network.

1. Implement a two-layer network and annotate tensor shapes. Compare a tiny manual gradient with automatic differentiation.
2. Write a training loop with batches, validation, reproducible seeds, and saved model weights.
3. Overfit a tiny batch to diagnose the pipeline. Then use early stopping on the real training split.
4. Compare the network with logistic regression and boosting. Report when the neural network loses.

Data: StatsBomb Open Data: events/{match_id}.json joined to match dates. For shots, use shot locations and outcomes. Split by whole match and date.

Evidence: A reproducible neural training run, a tiny-batch diagnostic, learning curves, and comparisons with simpler models.

Independent challenge: Trace a prediction and gradient through a tiny network. Explain train versus evaluation mode.

Reading: D2L chapters on linear networks, multilayer perceptrons, and training. Keep the network small enough for local experiments.

- [Dive into Deep Learning](https://d2l.ai/)

### Weeks 17–18: Understand attention

Build a small sequence model and an attention calculation for soccer events.

Learn embeddings, softmax attention, positional information, and masking through matrix operations.

1. Define a next-event task with information available at prediction time. Split by match and date.
2. Build a frequency baseline and a small recurrent or pooled-embedding baseline.
3. Implement scaled dot-product attention on a tiny sequence. Demonstrate why a future-event mask matters.
4. Train a small attention model if time permits. Otherwise evaluate the simpler sequence model and document the attention prototype.

Data: StatsBomb events/{match_id}.json: ordered events within each match. Define the target at a fixed prediction time and exclude all later events.

Evidence: A sequence baseline, a correct attention demonstration, and a clear account of whether training improved the task.

Independent challenge: Explain how attention weights are calculated and show a future-information leak prevented by a mask.

Reading: D2L attention and transformer chapters. Full transformer training is a stretch goal, not a completion requirement.

- [Dive into Deep Learning](https://d2l.ai/)

### Weeks 19–20: Read research like an engineer

Write two structured paper notes and design a small reproduction.

Connect assumptions, objective functions, experimental controls, effect sizes, and uncertainty to research claims.

1. Read the 2025 TabPFN paper and the 2026 tabular-prediction preprint. Record question, method, evidence, and limitations.
2. Trace one central equation into pseudocode. List every concept you cannot yet explain.
3. Choose one feasible claim about evaluation or tabular prediction. Specify data, baseline, metric, compute budget, and failure criteria.
4. Read one current Anthropic evaluation article. Explain how its evaluation principles transfer to your experiments.

Data: Reuse the frozen soccer datasets and splits. For reproduction, use the selected paper’s public data if feasible; otherwise label the soccer experiment as an adaptation.

Evidence: Two paper notes, one current research note, and a preregistered reproduction plan with a local compute budget.

Independent challenge: Separate an author claim from evidence and your inference. Name a confounder that can reverse the conclusion.

Reading: Use abstracts to choose questions, then inspect methods and limitations. Refresh the current article when this stage begins.

- [Accurate predictions on small data with a tabular foundation model · 2025](https://www.nature.com/articles/s41586-024-08328-6)
- [Why Large Language Models Fail at Tabular Prediction · August 2026](https://arxiv.org/abs/2608.02412)
- [Anthropic research](https://www.anthropic.com/research)

### Weeks 21–22: Reproduce and investigate

Reproduce one limited research result and run an ablation, an experiment that removes one component.

Apply confidence intervals, seed variability, multiple-comparison caution, and controlled comparisons.

1. Freeze data and code versions. Implement the selected experiment with a baseline and an explicit compute limit.
2. Run multiple seeds or resamples where appropriate. Record metrics and variation, not only the best run.
3. Remove one component and compare the result. Investigate a discrepancy with the original claim.
4. Write a short report that distinguishes exact reproduction, adaptation, and failure to reproduce.

Data: Reuse the frozen soccer datasets and splits. For reproduction, use the selected paper’s public data if feasible; otherwise label the soccer experiment as an adaptation.

Evidence: A rerunnable experiment, an ablation table, and a report with limitations and negative results.

Independent challenge: Explain which conclusion your data supports and which it does not. Rerun one result from a clean command.

Reading: If pretrained weights or hardware are unavailable, reproduce an evaluation comparison using your existing models and label the adaptation.

- [Accurate predictions on small data with a tabular foundation model · 2025](https://www.nature.com/articles/s41586-024-08328-6)
- [Why Large Language Models Fail at Tabular Prediction · August 2026](https://arxiv.org/abs/2608.02412)

### Weeks 23–24: Turn a model into a system

Package a local prediction service and an evaluation harness, code that measures model behavior consistently.

Study numerical stability, data contracts, profiling, test design, and distribution shift through your own system.

1. Package preprocessing and model weights together. Add a command that reproduces evaluation from saved data.
2. Test malformed inputs, missing values, changed categories, and data from a later period.
3. Measure prediction latency and memory use. Compare single predictions with batches. Document environment and model provenance.
4. Create a model report with intended use, training data, limitations, calibration, and monitoring signals.

Data: Reuse the frozen soccer datasets and splits. For reproduction, use the selected paper’s public data if feasible; otherwise label the soccer experiment as an adaptation.

Evidence: A local service or CLI, an evaluation harness, failure tests, performance measurements, and clear run instructions.

Independent challenge: Debug a failing prediction without an AI agent writing the fix. Explain how you would detect changing input data.

Reading: Use existing software skills. Spend time on ML-specific failure modes rather than introductory web development.

- [Anthropic research](https://www.anthropic.com/research)
- [Anthropic careers](https://www.anthropic.com/careers?hsLang=en)

### Weeks 25–26: Make the work legible

Finish two portfolio projects and assess the next six months against actual roles.

Integrate mathematical explanations, experimental reasoning, and engineering tradeoffs.

1. Finish a soccer prediction project with multiple models and a separate research reproduction with an ablation.
2. Give a recorded walkthrough: problem, data, loss, split, baseline, result, limitation, and next experiment.
3. Complete an independent exercise: train a simple model, explain its gradients, and diagnose a leaked feature.
4. Compare your evidence with two current engineering roles. Record gaps and select the next six-month focus.

Data: Reuse the frozen soccer datasets and splits. For reproduction, use the selected paper’s public data if feasible; otherwise label the soccer experiment as an adaptation.

Evidence: Two polished repositories or local project bundles, a technical walkthrough, and an honest skills assessment with a follow-on plan.

Independent challenge: Explain and modify your core model without generated code. Defend the experimental design and describe a result you do not trust.

Reading: The target is a stronger ML engineering portfolio. Frontier-lab hiring is selective and is not a guaranteed outcome of 286 study hours.

- [Anthropic careers](https://www.anthropic.com/careers?hsLang=en)
- [Anthropic research](https://www.anthropic.com/research)

## The next six months

- Deeper probability, Bayesian inference, optimization, and proof-based reasoning.
- Large-scale training, distributed systems, GPU programming, and performance engineering.
- Language-model training and evaluation, interpretability, and a sustained open-source contribution.
- A larger research reproduction with mentorship and role-specific interview practice.

## Sources

Links were reviewed on October 28, 2026. External reading requires internet access.

- [StatsBomb Open Data](https://github.com/hudl/open-data): Use the README, competition list, match files, event schema, and attribution terms. Select a historical competition with enough matches.
- [An Introduction to Statistical Learning · Python](https://www.statlearning.com/): Use selected chapters and Python labs. The book PDF is free on the authors’ site.
- [Mathematics for Machine Learning](https://mml-book.github.io/): Use selected sections as a reference after the visual experiment. The authors provide a free PDF.
- [3Blue1Brown · visual mathematics](https://www.3blue1brown.com/): Find the linear algebra and calculus lessons. Recreate one visual idea in code.
- [Dive into Deep Learning](https://d2l.ai/): Use the interactive book for calculus, automatic differentiation, training loops, and attention.
- [Accurate predictions on small data with a tabular foundation model · 2025](https://www.nature.com/articles/s41586-024-08328-6): Read the question, evaluation design, and limitations. Reproduce one feasible comparison, not the original training run.
- [Why Large Language Models Fail at Tabular Prediction · August 2026](https://arxiv.org/abs/2608.02412): Treat this preprint as a claim to examine. Compare its evaluation choices with your soccer experiments. No paid API experiment is required.
- [Anthropic research](https://www.anthropic.com/research): Select a recent public article about evaluations or model behavior. Follow its paper or methods link and record limitations.
- [Anthropic careers](https://www.anthropic.com/careers?hsLang=en): Compare your evidence with a current engineering role. Requirements change. This curriculum does not guarantee a role or a credential.
