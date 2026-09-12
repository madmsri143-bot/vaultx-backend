const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { db, asyncLocalStorage } = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = 'your-super-secret-jwt-key-for-local-dev';

// Middleware for auth
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    let uid = 'default';
    if (token && token !== 'dummy-token') {
        try {
            const base64Url = token.split('.')[1];
            if (base64Url) {
                const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
                const payload = JSON.parse(Buffer.from(base64, 'base64').toString());
                uid = payload.user_id || payload.sub || 'default';
            }
        } catch(e) {
            console.error('Error decoding token', e);
        }
    }
    
    req.user = { id: 1, uid, role: 'owner' };
    
    // Execute the request inside the isolated AsyncLocalStorage context
    asyncLocalStorage.run({ uid }, () => {
        next();
    });
};

const logTransaction = (action, amount, details) => {
    db.run("INSERT INTO transactions (action, amount, details) VALUES (?, ?, ?)", [action, amount, details]);
};

// Auth routes

// ---------------- CURRENCY SYSTEM ----------------

app.get('/api/currency', authenticateToken, (req, res) => {
    db.get("SELECT currency FROM user LIMIT 1", (err, userRow) => {
        const currentCurrency = userRow ? userRow.currency : 'INR';
        
        // Check if ANY financial entry exists to require conversion
        db.get("SELECT COUNT(*) as c1 FROM payouts", (err, row1) => {
            db.get("SELECT COUNT(*) as c2 FROM direct_contributions", (err, row2) => {
                db.get("SELECT COUNT(*) as c3 FROM expenses", (err, row3) => {
                    db.get("SELECT COUNT(*) as c4 FROM transactions", (err, row4) => {
                        db.get("SELECT COUNT(*) as c5 FROM budget_funding", (err, row5) => {
                            const c1 = row1 ? row1.c1 : 0;
                            const c2 = row2 ? row2.c2 : 0;
                            const c3 = row3 ? row3.c3 : 0;
                            const c4 = row4 ? row4.c4 : 0;
                            const c5 = row5 ? row5.c5 : 0;
                            const hasEntries = (c1 + c2 + c3 + c4 + c5) > 0;
                            res.json({ currency: currentCurrency, hasEntries });
                        });
                    });
                });
            });
        });
    });
});

app.post('/api/currency/convert', authenticateToken, (req, res) => {
    const { toCurrency, rate, hasEntries } = req.body;
    if (!toCurrency) return res.status(400).json({ error: "Currency required" });
    
    db.get("SELECT currency FROM user LIMIT 1", (err, userRow) => {
        if (err) return res.status(500).json({ error: err.message });
        const fromCurrency = userRow ? userRow.currency : 'INR';
        if (fromCurrency === toCurrency) return res.json({ message: "Same currency" });
        
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            db.run("UPDATE user SET currency = ?", [toCurrency]);
            
            if (hasEntries && rate && rate > 0) {
                // 1. expenses
                db.run("UPDATE expenses SET amount = amount * ?", [rate]);
                // 2. expense_transfers
                db.run("UPDATE expense_transfers SET amount = amount * ?", [rate]);
                // 3. budget_funding
                db.run("UPDATE budget_funding SET amount = amount * ?", [rate]);
                // 4. closed_months
                db.run("UPDATE closed_months SET budget = budget * ?, expenses = expenses * ?, remaining_balance = remaining_balance * ?", [rate, rate, rate]);
                // 5. transfer_history
                db.run("UPDATE transfer_history SET carry_forward_amount = carry_forward_amount * ?, savings_amount = savings_amount * ?, goals_amount = goals_amount * ?, remaining_balance = remaining_balance * ?", [rate, rate, rate, rate]);
                // 6. transactions
                db.run("UPDATE transactions SET amount = amount * ?", [rate]);
                // 7. funds
                db.run("UPDATE funds SET balance = balance * ?", [rate]);
                // 8. goals
                db.run("UPDATE goals SET target_amount = target_amount * ?, saved_amount = saved_amount * ?", [rate, rate]);
                
                // 9. currency_conversions
                db.run("CREATE TABLE IF NOT EXISTS currency_conversions (id INTEGER PRIMARY KEY AUTOINCREMENT, from_currency TEXT, to_currency TEXT, rate REAL, date DATETIME DEFAULT CURRENT_TIMESTAMP)");
                db.run("INSERT INTO currency_conversions (from_currency, to_currency, rate) VALUES (?, ?, ?)", [fromCurrency, toCurrency, rate]);
                
                // 10. payouts (JSON processing)
                db.all("SELECT id, amount, allocations FROM payouts", (err, rows) => {
                    if (rows) {
                        rows.forEach(row => {
                            let newAmount = row.amount * rate;
                            let newAllocs = row.allocations;
                            if (newAllocs) {
                                try {
                                    const parsed = JSON.parse(newAllocs);
                                    if (parsed.expenses !== undefined) parsed.expenses = parsed.expenses * rate;
                                    if (parsed.savings !== undefined) parsed.savings = parsed.savings * rate;
                                    if (parsed.goals !== undefined) parsed.goals = parsed.goals * rate;
                                    if (parsed.funds !== undefined) parsed.funds = parsed.funds * rate;
                                    if (parsed.external !== undefined) parsed.external = parsed.external * rate;
                                    if (parsed.savingsAllocations) {
                                        for (const key in parsed.savingsAllocations) {
                                            parsed.savingsAllocations[key] = parsed.savingsAllocations[key] * rate;
                                        }
                                    }
                                    if (parsed.goalAllocations) {
                                        for (const key in parsed.goalAllocations) {
                                            parsed.goalAllocations[key] = parsed.goalAllocations[key] * rate;
                                        }
                                    }
                                    newAllocs = JSON.stringify(parsed);
                                } catch (e) {}
                            }
                            db.run("UPDATE payouts SET amount = ?, allocations = ? WHERE id = ?", [newAmount, newAllocs, row.id]);
                        });
                    }
                });
                
                // 11. direct_contributions (JSON processing)
                db.all("SELECT id, amount, allocations FROM direct_contributions", (err, rows) => {
                    if (rows) {
                        rows.forEach(row => {
                            let newAmount = row.amount * rate;
                            let newAllocs = row.allocations;
                            if (newAllocs) {
                                try {
                                    const parsed = JSON.parse(newAllocs);
                                    if (parsed.savingsAllocations) {
                                        for (const key in parsed.savingsAllocations) {
                                            parsed.savingsAllocations[key] = parsed.savingsAllocations[key] * rate;
                                        }
                                    }
                                    if (parsed.goalAllocations) {
                                        for (const key in parsed.goalAllocations) {
                                            parsed.goalAllocations[key] = parsed.goalAllocations[key] * rate;
                                        }
                                    }
                                    if (parsed.fundAllocations) {
                                        for (const key in parsed.fundAllocations) {
                                            parsed.fundAllocations[key] = parsed.fundAllocations[key] * rate;
                                        }
                                    }
                                    newAllocs = JSON.stringify(parsed);
                                } catch(e) {}
                            }
                            db.run("UPDATE direct_contributions SET amount = ?, allocations = ? WHERE id = ?", [newAmount, newAllocs, row.id]);
                        });
                    }
                });
                
                // 12. transfer_history (JSON processing)
                db.all("SELECT id, allocations, breakdown_json FROM transfer_history", (err, rows) => {
                    if (rows) {
                        rows.forEach(row => {
                            let newAllocs = row.allocations;
                            if (newAllocs) {
                                try {
                                    const parsed = JSON.parse(newAllocs);
                                    if (parsed.savingsAllocations) {
                                        for (const key in parsed.savingsAllocations) {
                                            parsed.savingsAllocations[key] = parsed.savingsAllocations[key] * rate;
                                        }
                                    }
                                    if (parsed.goalAllocations) {
                                        for (const key in parsed.goalAllocations) {
                                            parsed.goalAllocations[key] = parsed.goalAllocations[key] * rate;
                                        }
                                    }
                                    newAllocs = JSON.stringify(parsed);
                                } catch(e) {}
                            }
                            
                            let newBreakdown = row.breakdown_json;
                            if (newBreakdown) {
                                try {
                                    const parsed = JSON.parse(newBreakdown);
                                    if (parsed.carryForward) parsed.carryForward = parsed.carryForward * rate;
                                    if (parsed.savings) parsed.savings = parsed.savings * rate;
                                    if (parsed.goals) parsed.goals = parsed.goals * rate;
                                    newBreakdown = JSON.stringify(parsed);
                                } catch(e) {}
                            }
                            db.run("UPDATE transfer_history SET allocations = ?, breakdown_json = ? WHERE id = ?", [newAllocs, newBreakdown, row.id]);
                        });
                    }
                });
            }

            db.run("COMMIT", (err) => {
                if (err) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ error: err.message });
                }
                res.json({ message: "Currency converted successfully" });
            });
        });
    });
});

app.post('/api/auth/login', (req, res) => {
    const { password } = req.body;
    db.get("SELECT * FROM user", (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(404).json({ error: "User not found" });

        bcrypt.compare(password, user.password_hash, (err, match) => {
            if (err) return res.status(500).json({ error: err.message });
            if (match) {
                const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '24h' });
                res.json({ token });
            } else {
                res.status(401).json({ error: "Invalid password" });
            }
        });
    });
});

app.post('/api/auth/change-password', authenticateToken, (req, res) => {
    const { oldPassword, newPassword } = req.body;
    db.get("SELECT * FROM user WHERE id = ?", [req.user.id], (err, user) => {
        bcrypt.compare(oldPassword, user.password_hash, (err, match) => {
            if (match) {
                bcrypt.hash(newPassword, 10, (err, hash) => {
                    db.run("UPDATE user SET password_hash = ? WHERE id = ?", [hash, req.user.id], (err) => {
                        if (err) return res.status(500).json({ error: err.message });
                        res.json({ message: "Password updated successfully" });
                    });
                });
            } else {
                res.status(401).json({ error: "Invalid old password" });
            }
        });
    });
});

// Dashboard Data
app.get('/api/dashboard', authenticateToken, (req, res) => {
    const dashboardData = {};
    
    const queries = [
        new Promise((resolve) => db.get("SELECT SUM(amount) as totalPayouts, COUNT(id) as payoutsCount FROM payouts", (err, row) => resolve({ totalPayouts: row.totalPayouts || 0, payoutsCount: row.payoutsCount || 0 }))),
        new Promise((resolve) => db.get("SELECT SUM(saved_amount) as totalSaved FROM goals", (err, row) => resolve({ totalSaved: row.totalSaved || 0 }))),
        new Promise((resolve) => db.get("SELECT balance FROM funds WHERE name = 'Personal Savings'", (err, row) => resolve({ personalSavings: row ? row.balance : 0 }))),
        new Promise((resolve) => db.all("SELECT * FROM goals WHERE status = 'Active'", (err, rows) => resolve({ activeGoals: rows }))),
        new Promise((resolve) => db.all("SELECT * FROM goals WHERE status = 'Completed'", (err, rows) => resolve({ completedGoals: rows }))),
        new Promise((resolve) => db.all("SELECT * FROM priority_tasks", (err, rows) => resolve({ priorityTasks: rows }))),
        new Promise((resolve) => db.all("SELECT * FROM transactions ORDER BY date DESC", (err, rows) => resolve({ recentTransactions: rows }))),
        new Promise((resolve) => db.get("SELECT balance FROM funds WHERE name = 'Expenses'", (err, row) => resolve({ expenseFund: row ? row.balance : 0 }))),
        new Promise((resolve) => db.get("SELECT SUM(amount) as total FROM budget_funding WHERE type = 'external'", (err, row) => resolve({ externalContributions: row && row.total ? row.total : 0 }))),
    ];

    Promise.all(queries).then(results => {
        results.forEach(result => Object.assign(dashboardData, result));
        res.json(dashboardData);
    }).catch(err => res.status(500).json({ error: err.message }));
});

// Analytics Data
app.get('/api/analytics', authenticateToken, (req, res) => {
    const analyticsData = {};
    
    const queries = [
        new Promise((resolve) => db.all("SELECT status, COUNT(*) as count FROM goals GROUP BY status", (err, rows) => {
            const counts = { Active: 0, Completed: 0, Archived: 0 };
            rows?.forEach(r => counts[r.status] = r.count);
            resolve({ goalCounts: counts });
        })),
        new Promise((resolve) => db.get("SELECT SUM(target_amount) as totalValue, SUM(saved_amount) as totalSaved FROM goals", (err, row) => {
            resolve({ 
                totalValue: row?.totalValue || 0, 
                totalSaved: row?.totalSaved || 0,
                completionRate: row?.totalValue ? (row.totalSaved / row.totalValue) * 100 : 0
            });
        })),
        new Promise((resolve) => db.all("SELECT strftime('%Y-%m', date) as month, SUM(amount) as total FROM payouts GROUP BY month ORDER BY month", (err, rows) => {
            resolve({ monthlyContributions: rows || [] });
        }))
    ];

    Promise.all(queries).then(results => {
        results.forEach(result => Object.assign(analyticsData, result));
        res.json(analyticsData);
    }).catch(err => res.status(500).json({ error: err.message }));
});

// Payouts Helpers
  const reverseAllocations = (allocs) => {
      if (allocs.expenses > 0) {
          db.run("UPDATE funds SET balance = MAX(0, balance - ?) WHERE name = 'Expenses'", [allocs.expenses]);
      }
      if (allocs.personalSavings > 0) {
          db.run("UPDATE funds SET balance = MAX(0, balance - ?) WHERE name = 'Personal Savings'", [allocs.personalSavings]);
      }
      if (allocs.goals && allocs.goals.length > 0) {
          allocs.goals.forEach(g => {
              if (g.amount > 0) {
                  db.run("UPDATE goals SET saved_amount = MAX(0, saved_amount - ?) WHERE id = ?", [g.amount, g.id]);
                  db.run("UPDATE goals SET status = 'Active', completed_at = NULL WHERE id = ? AND status = 'Completed' AND saved_amount < target_amount", [g.id]);
              }
          });
      }
  };

  const applyAllocations = (allocs) => {
      if (allocs.expenses > 0) {
          db.run("UPDATE funds SET balance = balance + ? WHERE name = 'Expenses'", [allocs.expenses]);
      }
      if (allocs.personalSavings > 0) {
          db.run("UPDATE funds SET balance = balance + ? WHERE name = 'Personal Savings'", [allocs.personalSavings]);
          logTransaction("Auto Split Allocation", allocs.personalSavings, `Allocated from Payout`);
      }
      if (allocs.goals && allocs.goals.length > 0) {
          allocs.goals.forEach(g => {
              if (g.amount > 0) {
                  db.run(`
                      UPDATE goals 
                      SET saved_amount = saved_amount + ?,
                          status = CASE WHEN status = 'Active' AND (saved_amount + ?) >= target_amount THEN 'Completed' ELSE status END,
                          completed_at = CASE WHEN status = 'Active' AND (saved_amount + ?) >= target_amount THEN CURRENT_TIMESTAMP ELSE completed_at END
                      WHERE id = ?
                  `, [g.amount, g.amount, g.amount, g.id]);
              }
          });
      }
  };

  // Payouts Endpoints
  app.get('/api/payouts', authenticateToken, (req, res) => {
      db.all("SELECT * FROM payouts ORDER BY date DESC", (err, rows) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json(rows);
      });
  });

  app.post('/api/payouts', authenticateToken, (req, res) => {
      const { date, amount, note, autoSplit } = req.body;
      db.serialize(() => {
          db.run("BEGIN TRANSACTION", (err) => {
              if (err) return res.status(500).json({ error: err.message });
              
              const allocStr = autoSplit ? JSON.stringify(autoSplit) : null;
              db.run("INSERT INTO payouts (date, amount, note, allocations) VALUES (?, ?, ?, ?)", [date, amount, note, allocStr], function(err) {
                  if (err) {
                      db.run("ROLLBACK");
                      return res.status(500).json({ error: err.message });
                  }
                  const payoutId = this.lastID;
                  logTransaction("Added Payout", amount, `Date: ${date}, Note: ${note}`);
                  
                  if (autoSplit) {
                        applyAllocations(autoSplit);
                    }
                    db.run("COMMIT", (commitErr) => {
                        if (commitErr) return res.status(500).json({ error: commitErr.message });
                        res.json({ id: payoutId });
                    });
                });
          });
      });
  });

  app.put('/api/payouts/:id', authenticateToken, (req, res) => {
      const { date, amount, note, autoSplit } = req.body;
      db.serialize(() => {
          db.run("BEGIN TRANSACTION", (err) => {
              if (err) return res.status(500).json({ error: err.message });
              
              db.get("SELECT allocations FROM payouts WHERE id = ?", [req.params.id], (err, row) => {
                  if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                  
                  if (row && row.allocations) {
                      try {
                          const oldAllocs = JSON.parse(row.allocations);
                          reverseAllocations(oldAllocs);
                      } catch(e) {}
                  }
                  
                  if (autoSplit) {
                      applyAllocations(autoSplit);
                  }
                  
                  const allocStr = autoSplit ? JSON.stringify(autoSplit) : null;
                  db.run("UPDATE payouts SET date = ?, amount = ?, note = ?, allocations = ? WHERE id = ?", 
                      [date, amount, note, allocStr, req.params.id], function(err) {
                      if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
    db.run("COMMIT", (commitErr) => {
        if (commitErr) return res.status(500).json({ error: commitErr.message });
        res.json({ message: "Success" });
    });
});
              });
          });
      });
  });

  app.delete('/api/payouts/:id', authenticateToken, (req, res) => {
      db.serialize(() => {
          db.run("BEGIN TRANSACTION", (err) => {
              if (err) return res.status(500).json({ error: err.message });
              
              db.get("SELECT allocations FROM payouts WHERE id = ?", [req.params.id], (err, row) => {
                  if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                  
                  if (row && row.allocations) {
                      try {
                          const oldAllocs = JSON.parse(row.allocations);
                          reverseAllocations(oldAllocs);
                      } catch(e) {}
                  }
                  
                  db.run("DELETE FROM payouts WHERE id = ?", [req.params.id], function(err) {
                      if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
    db.run("COMMIT", (commitErr) => {
        if (commitErr) return res.status(500).json({ error: commitErr.message });
        res.json({ message: "Success" });
    });
});
              });
          });
      });
  });

// Direct Contributions Endpoints
  app.get('/api/direct-contributions', authenticateToken, (req, res) => {
      db.all("SELECT * FROM direct_contributions ORDER BY date DESC", (err, rows) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json(rows);
      });
  });

  app.post('/api/direct-contributions', authenticateToken, (req, res) => {
      const { date, amount, note, allocation_type, allocations } = req.body;
      db.serialize(() => {
          db.run("BEGIN TRANSACTION", (err) => {
              if (err) return res.status(500).json({ error: err.message });
              
              const allocStr = allocations ? JSON.stringify(allocations) : null;
              db.run("INSERT INTO direct_contributions (date, amount, note, allocation_type, allocations) VALUES (?, ?, ?, ?, ?)", 
                  [date, amount, note || '', allocation_type || 'savings', allocStr], 
                  function(err) {
                      if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                      const dcId = this.lastID;
                      
                      if (allocations) {
                          applyAllocations(allocations);
                      }
                      db.run("COMMIT", (commitErr) => {
                          if (commitErr) return res.status(500).json({ error: commitErr.message });
                          res.json({ id: dcId });
                      });
                  });
          });
      });
  });

  app.put('/api/direct-contributions/:id', authenticateToken, (req, res) => {
      const { date, amount, note, allocation_type, allocations } = req.body;
      db.serialize(() => {
          db.run("BEGIN TRANSACTION", (err) => {
              if (err) return res.status(500).json({ error: err.message });
              
              db.get("SELECT allocations FROM direct_contributions WHERE id = ?", [req.params.id], (err, row) => {
                  if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                  
                  if (row && row.allocations) {
                      try {
                          const oldAllocs = JSON.parse(row.allocations);
                          reverseAllocations(oldAllocs);
                      } catch(e) {}
                  }
                  
                  if (allocations) {
                      applyAllocations(allocations);
                  }
                  
                  const allocStr = allocations ? JSON.stringify(allocations) : null;
                  db.run("UPDATE direct_contributions SET date = ?, amount = ?, note = ?, allocation_type = ?, allocations = ? WHERE id = ?", 
                      [date, amount, note || '', allocation_type || 'savings', allocStr, req.params.id], 
                      function(err) {
                          if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
    db.run("COMMIT", (commitErr) => {
        if (commitErr) return res.status(500).json({ error: commitErr.message });
        res.json({ message: "Success" });
    });
});
              });
          });
      });
  });

  app.delete('/api/direct-contributions/:id', authenticateToken, (req, res) => {
      db.serialize(() => {
          db.run("BEGIN TRANSACTION", (err) => {
              if (err) return res.status(500).json({ error: err.message });
              
              db.get("SELECT allocations FROM direct_contributions WHERE id = ?", [req.params.id], (err, row) => {
                  if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                  
                  if (row && row.allocations) {
                      try {
                          const oldAllocs = JSON.parse(row.allocations);
                          reverseAllocations(oldAllocs);
                      } catch(e) {}
                  }
                  
                  db.run("DELETE FROM direct_contributions WHERE id = ?", [req.params.id], function(err) {
                      if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
    db.run("COMMIT", (commitErr) => {
        if (commitErr) return res.status(500).json({ error: commitErr.message });
        res.json({ message: "Success" });
    });
});
              });
          });
      });
  });

// Goals
app.get('/api/goals', authenticateToken, (req, res) => {
    db.all("SELECT * FROM goals", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/goals', authenticateToken, (req, res) => {
    const { name, target_amount, saved_amount, notes, icon, weight } = req.body;
    db.run("INSERT INTO goals (name, target_amount, saved_amount, notes, icon, weight, status) VALUES (?, ?, ?, ?, ?, ?, 'Active')", [name, target_amount, saved_amount || 0, notes, icon || 'ðŸŽ¯', weight || 0], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID });
    });
});

app.put('/api/goals/:id', authenticateToken, (req, res) => {
    const { name, target_amount, saved_amount, notes, icon, weight } = req.body;
    if (saved_amount < 0 || target_amount < 0) return res.status(400).json({ error: "Cannot be negative" });

    db.get("SELECT status FROM goals WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(500).json({ error: err?.message || "Goal not found" });

        let newStatus = row.status;
        let completed_at_update = "";
        let params = [name, target_amount, saved_amount, notes, icon || 'ðŸŽ¯', weight || 0];

        if (row.status !== 'Archived') {
            if (saved_amount >= target_amount && row.status === 'Active') {
                newStatus = 'Completed';
                completed_at_update = ", completed_at = CURRENT_TIMESTAMP";
            } else if (saved_amount < target_amount && row.status === 'Completed') {
                newStatus = 'Active';
                completed_at_update = ", completed_at = NULL";
            }
        }
        
        params.push(newStatus);
        params.push(req.params.id);

        db.run(`UPDATE goals SET name = ?, target_amount = ?, saved_amount = ?, notes = ?, icon = ?, weight = ?, status = ? ${completed_at_update} WHERE id = ?`, params, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Updated", status: newStatus });
        });
    });
});

app.put('/api/goals/:id/status', authenticateToken, (req, res) => {
    const { status } = req.body;
    db.get("SELECT saved_amount, target_amount FROM goals WHERE id = ?", [req.params.id], (err, row) => {
        if (err || !row) return res.status(500).json({ error: err?.message || "Goal not found" });

        let finalStatus = status;
        let timeUpdate = "";
        
        if (status === 'Archived') {
            timeUpdate = ", archived_at = CURRENT_TIMESTAMP";
        } else if (status === 'Restored') {
            if (row.saved_amount >= row.target_amount) {
                finalStatus = 'Completed';
            } else {
                finalStatus = 'Active';
            }
            timeUpdate = ", archived_at = NULL";
        }

        db.run(`UPDATE goals SET status = ? ${timeUpdate} WHERE id = ?`, [finalStatus, req.params.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Status updated" });
        });
    });
});

app.delete('/api/goals/:id', authenticateToken, (req, res) => {
    db.run("DELETE FROM goals WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Deleted" });
    });
});

// Funds

app.get('/api/expenses/external-contributions', authenticateToken, (req, res) => {
    db.get("SELECT SUM(amount) as total FROM budget_funding WHERE type = 'external'", (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ total: row && row.total ? row.total : 0 });
    });
});

app.get('/api/funds', authenticateToken, (req, res) => {
    db.all("SELECT * FROM funds", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.put('/api/funds/:name', authenticateToken, (req, res) => {
    const { balance, transactionLog } = req.body;
    if (balance < 0) return res.status(400).json({ error: "Balance cannot be negative" });
    
    db.get("SELECT balance FROM funds WHERE name = ?", [req.params.name], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        const oldBalance = row ? row.balance : 0;
        const diff = balance - oldBalance;
        
        db.run("UPDATE funds SET balance = ? WHERE name = ?", [balance, req.params.name], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            
            if (diff !== 0 && req.params.name === 'Personal Savings') {
                let actionDesc = transactionLog ? transactionLog.action : (diff > 0 ? `Personal Savings +â‚¹${diff}` : `Personal Savings -â‚¹${Math.abs(diff)}`);
                logTransaction(actionDesc, Math.abs(diff), `Balance updated to â‚¹${balance}`);
            }
            res.json({ message: "Updated" });
        });
    });
});

// Priority Tasks
app.get('/api/tasks', authenticateToken, (req, res) => {
    db.all("SELECT * FROM priority_tasks", (err, tasks) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all("SELECT * FROM subtasks", (err, subtasks) => {
            if (err) return res.status(500).json({ error: err.message });
            tasks.forEach(task => {
                task.subtasks = subtasks.filter(st => st.task_id === task.id);
            });
            res.json(tasks);
        });
    });
});

app.post('/api/tasks', authenticateToken, (req, res) => {
    const { title, description } = req.body;
    db.run("INSERT INTO priority_tasks (title, description, status) VALUES (?, ?, 'Pending')", [title, description || ''], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID });
    });
});

app.put('/api/tasks/:id', authenticateToken, (req, res) => {
    const { title, status } = req.body;
    // Keep it flexible so we can update either just status, or title, or both.
    // If title is provided, update both title and status. Otherwise just status.
    if (title) {
        db.run("UPDATE priority_tasks SET title = ?, status = ? WHERE id = ?", [title, status, req.params.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Updated" });
        });
    } else {
        db.run("UPDATE priority_tasks SET status = ? WHERE id = ?", [status, req.params.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Updated" });
        });
    }
});

app.delete('/api/tasks/:id', authenticateToken, (req, res) => {
    db.serialize(() => {
        db.run("DELETE FROM subtasks WHERE task_id = ?", [req.params.id]);
        db.run("DELETE FROM priority_tasks WHERE id = ?", [req.params.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Deleted" });
        });
    });
});

app.post('/api/tasks/:id/subtasks', authenticateToken, (req, res) => {
    const { title } = req.body;
    db.run("INSERT INTO subtasks (task_id, title, status) VALUES (?, ?, 'Pending')", [req.params.id, title], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID });
    });
});

app.put('/api/subtasks/:id', authenticateToken, (req, res) => {
    const { status } = req.body;
    db.run("UPDATE subtasks SET status = ? WHERE id = ?", [status, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Updated" });
    });
});

app.delete('/api/subtasks/:id', authenticateToken, (req, res) => {
    db.run("DELETE FROM subtasks WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Deleted" });
    });
});

// Transactions
app.get('/api/transactions', authenticateToken, (req, res) => {
    db.all("SELECT * FROM transactions ORDER BY date DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Settings / Export / Import / Reset
app.get('/api/data/export', authenticateToken, (req, res) => {
    const data = {};
    const tables = ['payouts', 'goals', 'funds', 'priority_tasks', 'subtasks', 'transactions'];
    let completed = 0;

    tables.forEach(table => {
        db.all(`SELECT * FROM ${table}`, (err, rows) => {
            if (!err) data[table] = rows;
            completed++;
            if (completed === tables.length) {
                res.json(data);
            }
        });
    });
});

app.post('/api/data/import', authenticateToken, (req, res) => {
    const data = req.body;
    db.serialize(() => {
        const tables = ['payouts', 'goals', 'funds', 'priority_tasks', 'subtasks', 'transactions'];
        tables.forEach(table => {
            if (data[table]) {
                db.run(`DELETE FROM ${table}`); // Clear existing data
                data[table].forEach(row => {
                    const columns = Object.keys(row).join(', ');
                    const placeholders = Object.keys(row).map(() => '?').join(', ');
                    const values = Object.values(row);
                    db.run(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`, values);
                });
            }
        });
    });
    res.json({ message: "Import successful" });
});

app.post('/api/data/reset', authenticateToken, (req, res) => {
    const { category } = req.body;
    if (category === 'all') {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            db.run("DELETE FROM payouts");
            db.run("DELETE FROM direct_contributions");
            db.run("DELETE FROM goals");
            db.run("UPDATE funds SET balance = 0");
            db.run("DELETE FROM priority_tasks");
            db.run("DELETE FROM subtasks");
            db.run("DELETE FROM expenses");
            db.run("DELETE FROM expense_transfers");
            db.run("DELETE FROM budget_funding");
            db.run("DELETE FROM closed_months");
            db.run("DELETE FROM transfer_history");
            db.run("DELETE FROM transactions", (err) => {
                db.run("COMMIT", (commitErr) => {
                    if (commitErr || err) return res.status(500).json({ error: (commitErr || err).message });
                    res.json({ message: "Reset successful" });
                });
            });
        });
    } else if (category === 'payouts') {
        db.run("DELETE FROM payouts", (err) => { res.json({ message: "Reset successful" }); });
    } else if (category === 'goals') {
        db.run("UPDATE goals SET saved_amount = 0", (err) => { res.json({ message: "Reset successful" }); });
    } else if (category === 'funds') {
        db.run("UPDATE funds SET balance = 0", (err) => { res.json({ message: "Reset successful" }); });
    }
});


// ==========================================
// EXPENSE TRACKER API
// ==========================================


// --- Monthly Closure Endpoints ---

app.get('/api/closed-months', authenticateToken, (req, res) => {
    db.all("SELECT * FROM closed_months ORDER BY month_year DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/expenses/close-month', authenticateToken, (req, res) => {
    const { month, year } = req.body;
    if (!month || !year) return res.status(400).json({ error: "Month and year required" });
    const monthPrefix = `${year}-${month}`;

    db.get("SELECT * FROM closed_months WHERE month_year = ?", [monthPrefix], (err, closedRow) => {
        if (err) return res.status(500).json({ error: err.message });
        if (closedRow) {
            // Already closed! Return the fixed historical data + flag it
            return res.json({ 
                month_year: closedRow.month_year, 
                budget: closedRow.budget, 
                expenses: closedRow.expenses, 
                remaining_balance: closedRow.remaining_balance,
                already_closed: true
            });
        }

        db.serialize(() => {
            let budget = 0;
            let expensesTotal = 0;
            
            db.all("SELECT allocations FROM payouts WHERE date LIKE ?", [`${monthPrefix}%`], (err, payouts) => {
                if (payouts) {
                    payouts.forEach(p => {
                        if (p.allocations) {
                            try {
                                const allocs = JSON.parse(p.allocations);
                                if (allocs.expenses) budget += allocs.expenses;
                            } catch(e) {}
                        }
                    });
                }
                
                db.all("SELECT allocations FROM direct_contributions WHERE date LIKE ?", [`${monthPrefix}%`], (err, dcs) => {
                    if (dcs) {
                        dcs.forEach(dc => {
                            if (dc.allocations) {
                                try {
                                    const allocs = JSON.parse(dc.allocations);
                                    if (allocs.expenses) budget += allocs.expenses;
                                } catch(e) {}
                            }
                        });
                    }
                    
                    db.all("SELECT type, amount FROM budget_funding WHERE date LIKE ?", [`${monthPrefix}%`], (err, fundings) => {
                        if (fundings) {
                            fundings.forEach(f => {
                                budget += f.amount;
                            });
                        }

                        db.get("SELECT SUM(amount) as total FROM expenses WHERE date LIKE ?", [`${monthPrefix}%`], (err, expRow) => {
                            expensesTotal = expRow && expRow.total ? expRow.total : 0;
                            const remainingBalance = budget - expensesTotal;
                            
                            // NEW: Gather complete snapshot of dashboard at this exact moment
                            const snapshotQueries = [
                                new Promise((resolve) => db.get("SELECT SUM(amount) as total FROM payouts WHERE date LIKE ?", [`${monthPrefix}%`], (err, row) => resolve({ monthIncomePayouts: row && row.total ? row.total : 0 }))),
                                new Promise((resolve) => db.get("SELECT SUM(amount) as total FROM direct_contributions WHERE date LIKE ?", [`${monthPrefix}%`], (err, row) => resolve({ monthIncomeDirect: row && row.total ? row.total : 0 }))),
                                new Promise((resolve) => db.get("SELECT SUM(saved_amount) as totalSaved FROM goals", (err, row) => resolve({ totalSaved: row.totalSaved || 0 }))),
                                new Promise((resolve) => db.get("SELECT balance FROM funds WHERE name = 'Personal Savings'", (err, row) => resolve({ personalSavings: row ? row.balance : 0 }))),
                                new Promise((resolve) => db.all("SELECT * FROM goals WHERE status = 'Active'", (err, rows) => resolve({ activeGoals: rows || [] }))),
                                new Promise((resolve) => db.all("SELECT * FROM goals WHERE status = 'Completed'", (err, rows) => resolve({ completedGoals: rows || [] })))
                            ];
                            
                            Promise.all(snapshotQueries).then(results => {
                                const snapshot = {
                                    monthBudget: budget,
                                    monthExpenses: expensesTotal,
                                    remainingBalance: remainingBalance
                                };
                                results.forEach(result => Object.assign(snapshot, result));
                                
                                db.run("INSERT INTO closed_months (month_year, budget, expenses, remaining_balance, snapshot_json) VALUES (?, ?, ?, ?, ?)",
                                    [monthPrefix, budget, expensesTotal, remainingBalance, JSON.stringify(snapshot)], function(err) {
                                        if (err) return res.status(500).json({ error: err.message });
                                        res.json({ month_year: monthPrefix, budget, expenses: expensesTotal, remaining_balance: remainingBalance, snapshot, already_closed: false });
                                    });
                            }).catch(err => {
                                res.status(500).json({ error: err.message });
                            });
                        });
                    });
                });
            });
        });
    });
});

app.post('/api/expenses/transfer-remaining', authenticateToken, (req, res) => {
    const { previousMonth, nextMonthDate, remainingBalance, savingsAmount, goalsAmount, carryForwardAmount, allocations } = req.body;
    
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        
        // 1. Insert into transfer_history
        db.run("INSERT INTO transfer_history (previous_month, remaining_balance, savings_amount, goals_amount, carry_forward_amount, allocations) VALUES (?, ?, ?, ?, ?, ?)",
            [previousMonth, remainingBalance, savingsAmount, goalsAmount, carryForwardAmount, allocations ? JSON.stringify(allocations) : null], function(err) {
            if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
            
            // 2. Add to Personal Savings
            if (savingsAmount > 0) {
                db.run("UPDATE funds SET balance = balance + ? WHERE name = 'Personal Savings'", [savingsAmount], (err) => {
                    if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                });
            }
            
            // 3. Add to Goals
            if (goalsAmount > 0 && allocations) {
                Object.entries(allocations).forEach(([goalId, amount]) => {
                    if (amount > 0) {
                        db.run("UPDATE goals SET saved_amount = saved_amount + ? WHERE id = ?", [amount, goalId], (err) => {
                            if (err) console.error(err);
                        });
                    }
                });
            }
            
            // 4. Carry Forward (Insert as budget_funding in next month)
            if (carryForwardAmount > 0) {
                db.run("INSERT INTO budget_funding (date, type, source_name, amount, notes) VALUES (?, 'carry_forward', 'Previous Month Balance', ?, ?)",
                    [nextMonthDate, carryForwardAmount, `Carry forward from ${previousMonth}`], (err) => {
                    if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                });
            }
            
            // 5. Do NOT deduct transferred money from Expenses fund. 
            // The Expense Fund is a lifetime accumulator of all expense allocations.
            db.run("COMMIT", (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: "Transferred successfully" });
            });
        });
    });
});


app.put('/api/expenses/transfer-history/:id', authenticateToken, (req, res) => {
    const id = req.params.id;
    const { savingsAmount, goalsAmount, carryForwardAmount, allocations } = req.body;
    
    db.get("SELECT * FROM transfer_history WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Transfer not found" });
        
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            
            // 1. Reverse old savings
            if (row.savings_amount > 0) {
                db.run("UPDATE funds SET balance = balance - ? WHERE name = 'Personal Savings'", [row.savings_amount], (err) => {
                    if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                });
            }
            
            // 2. Reverse old goals
            if (row.goals_amount > 0 && row.allocations) {
                try {
                    const oldAllocs = JSON.parse(row.allocations);
                    Object.entries(oldAllocs).forEach(([goalId, amt]) => {
                        db.run("UPDATE goals SET saved_amount = saved_amount - ? WHERE id = ?", [amt, goalId], (err) => {
                            if (err) console.error(err);
                        });
                    });
                } catch(e) {}
            }
            
            // 3. Reverse old carry_forward (delete budget_funding)
            if (row.carry_forward_amount > 0) {
                db.run("DELETE FROM budget_funding WHERE type = 'carry_forward' AND notes = ?", [`Carry forward from ${row.previous_month}`], (err) => {
                    if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                });
            }
            
            // 4. Apply new savings
            if (savingsAmount > 0) {
                db.run("UPDATE funds SET balance = balance + ? WHERE name = 'Personal Savings'", [savingsAmount], (err) => {
                    if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                });
            }
            
            // 5. Apply new goals
            if (goalsAmount > 0 && allocations) {
                Object.entries(allocations).forEach(([goalId, amt]) => {
                    db.run("UPDATE goals SET saved_amount = saved_amount + ? WHERE id = ?", [amt, goalId], (err) => {
                        if (err) console.error(err);
                    });
                });
            }
            
            // 6. Apply new carry_forward
            if (carryForwardAmount > 0) {
                // Find next month's date or just use first of next month
                const parts = row.previous_month.split('-'); // e.g. "2024-09"
                let year = parseInt(parts[0]);
                let month = parseInt(parts[1]);
                if (month === 12) {
                    year++;
                    month = 1;
                } else {
                    month++;
                }
                const nextMonthDate = `${year}-${month.toString().padStart(2, '0')}-01`;
                
                db.run("INSERT INTO budget_funding (date, type, source_name, amount, notes) VALUES (?, 'carry_forward', 'Previous Month Balance', ?, ?)",
                    [nextMonthDate, carryForwardAmount, `Carry forward from ${row.previous_month}`], (err) => {
                    if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                });
            }
            
            // 7. Update transfer_history record
            db.run("UPDATE transfer_history SET savings_amount = ?, goals_amount = ?, carry_forward_amount = ?, allocations = ? WHERE id = ?",
                [savingsAmount, goalsAmount, carryForwardAmount, allocations ? JSON.stringify(allocations) : null, id], (err) => {
                if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
    db.run("COMMIT", (commitErr) => {
        if (commitErr) return res.status(500).json({ error: commitErr.message });
        res.json({ message: "Success" });
    });
});
        });
    });
});

app.get('/api/expenses/transfer-history', authenticateToken, (req, res) => {
    db.all("SELECT * FROM transfer_history ORDER BY created_at DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- End Monthly Closure Endpoints ---
app.get('/api/expenses/dashboard', authenticateToken, (req, res) => {
    const { month, year } = req.query;
    
    // Helper to process after we determine the target monthPrefix
    const processDashboard = (monthPrefix, targetMonth, targetYear) => {
        db.get("SELECT * FROM closed_months WHERE month_year = ?", [monthPrefix], (err, closedRow) => {
            let isClosed = !!closedRow;
            let closedBudget = closedRow ? closedRow.budget : 0;
            let closedExpenses = closedRow ? closedRow.expenses : 0;
            let closedRemaining = closedRow ? closedRow.remaining_balance : 0;

            db.serialize(() => {
                let budget = 0;
                let expensesTotal = 0;
                let expensesList = [];
                let transferBreakdown = [];
                let transferredTotal = 0;
                let savingsFunding = 0;
                let goalsFunding = 0;
                let externalFunding = 0;
                
                db.all("SELECT allocations FROM payouts WHERE date LIKE ?", [`${monthPrefix}%`], (err, payouts) => {
                    if (payouts) payouts.forEach(p => {
                        if (p.allocations) {
                            try {
                                const allocs = JSON.parse(p.allocations);
                                if (allocs.expenses) budget += allocs.expenses;
                            } catch(e) {}
                        }
                    });
                    
                    db.all("SELECT allocations FROM direct_contributions WHERE date LIKE ?", [`${monthPrefix}%`], (err, dcs) => {
                        if (dcs) dcs.forEach(dc => {
                            if (dc.allocations) {
                                try {
                                    const allocs = JSON.parse(dc.allocations);
                                    if (allocs.expenses) budget += allocs.expenses;
                                } catch(e) {}
                            }
                        });
                        
                        db.all("SELECT * FROM budget_funding WHERE date LIKE ?", [`${monthPrefix}%`], (err, fundings) => {
                            let budgetFundingHistory = fundings || [];
                            if (fundings) fundings.forEach(f => {
                                budget += f.amount;
                                if (f.type === 'savings') savingsFunding += f.amount;
                                else if (f.type === 'goal') goalsFunding += f.amount;
                                else if (f.type === 'external') externalFunding += f.amount;
                            });

                            db.get("SELECT SUM(amount) as total FROM expenses WHERE date LIKE ?", [`${monthPrefix}%`], (err, expRow) => {
                                expensesTotal = expRow && expRow.total ? expRow.total : 0;
                                
                                db.all("SELECT * FROM expenses WHERE date LIKE ? ORDER BY date DESC", [`${monthPrefix}%`], (err, exps) => {
                                    expensesList = exps || [];
                                    
                                    db.all("SELECT * FROM funds", (err, fundsList) => {
                                        const fund = fundsList ? fundsList.find(f => f.name === 'Expenses') : null;
                                        const savingsFund = fundsList ? fundsList.find(f => f.name === 'Personal Savings') : null;
                                        db.all("SELECT * FROM goals WHERE status = 'Active'", (err, goals) => {
                                            
                                            // Handle Transfer History parsing for reports
                                            db.get("SELECT * FROM transfer_history WHERE previous_month = ?", [monthPrefix], (err, transRow) => {
                                                if (transRow) {
                                                    try {
                                                        const breakdown = JSON.parse(transRow.breakdown_json);
                                                        transferredTotal = transRow.total_remaining;
                                                    } catch(e) {}
                                                }

                                                const globalRemaining = fund ? fund.balance : 0;
                                                const remaining = Math.max(0, budget - expensesTotal);
                                                const potSavings = remaining;

                                                res.json({
                                                    month: targetMonth,
                                                    year: targetYear,
                                                    month_year: monthPrefix,
                                                    budget: isClosed ? closedBudget : budget,
                                                    expensesTotal: isClosed ? closedExpenses : expensesTotal,
                                                    remaining: isClosed ? closedRemaining : remaining,
                                                    globalRemaining,
                                                    potentialSavings: isClosed ? closedRemaining : potSavings,
                                                    expenses: expensesList,
                                                    activeGoals: goals || [],
                                                    isClosed,
                                                    budgetFundingHistory,
                                                    savingsFunding,
                                                    goalsFunding,
                                                    externalFunding,
                                                    transferredTotal,
                                                    personalSavingsBalance: savingsFund ? savingsFund.balance : 0
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    };

    if (month && year) {
        const targetMonth = month.padStart(2, '0');
        const targetYear = year;
        const monthPrefix = `${targetYear}-${targetMonth}`;
        processDashboard(monthPrefix, targetMonth, targetYear);
    } else {
        // Auto-detect latest month from payouts
        db.get("SELECT strftime('%Y-%m', date) as month_year FROM payouts ORDER BY date DESC LIMIT 1", (err, row) => {
            if (row && row.month_year) {
                const parts = row.month_year.split('-');
                processDashboard(row.month_year, parts[1], parts[0]);
            } else {
                const currentDate = new Date();
                const targetMonth = String(currentDate.getMonth() + 1).padStart(2, '0');
                const targetYear = String(currentDate.getFullYear());
                const monthPrefix = `${targetYear}-${targetMonth}`;
                processDashboard(monthPrefix, targetMonth, targetYear);
            }
        });
    }
});

app.get('/api/expenses', authenticateToken, (req, res) => {
    db.all("SELECT * FROM expenses ORDER BY date DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/expenses', authenticateToken, (req, res) => {
    const { date, amount, category, description } = req.body;
    if (amount === undefined || amount < 0) return res.status(400).json({ error: "Amount must be greater than or equal to 0" });
    
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run("INSERT INTO expenses (date, amount, category, description) VALUES (?, ?, ?, ?)", 
            [date, amount, category || 'Other', description || ''], function(err) {
            if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
            
            const expenseId = this.lastID;
            
            db.run("COMMIT", (commitErr) => {
                if (commitErr) return res.status(500).json({ error: commitErr.message });
                res.json({ id: expenseId });
            });
        });
    });
});

app.put('/api/expenses/:id', authenticateToken, (req, res) => {
    const { date, amount, category, description } = req.body;
    const expenseId = req.params.id;
    
    db.get("SELECT amount FROM expenses WHERE id = ?", [expenseId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Expense not found" });
        const oldAmount = row.amount;
        const diff = amount - oldAmount;
        
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            db.run("UPDATE expenses SET date = ?, amount = ?, category = ?, description = ? WHERE id = ?",
                [date, amount, category, description, expenseId], (err) => {
                if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
    db.run("COMMIT", (commitErr) => {
        if (commitErr) return res.status(500).json({ error: commitErr.message });
        res.json({ message: "Success" });
    });
});
        });
    });
});

app.delete('/api/expenses/:id', authenticateToken, (req, res) => {
    const expenseId = req.params.id;
    
    db.get("SELECT amount FROM expenses WHERE id = ?", [expenseId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Expense not found" });
        const amount = row.amount;
        
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            db.run("DELETE FROM expenses WHERE id = ?", [expenseId], (err) => {
                if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
    db.run("COMMIT", (commitErr) => {
        if (commitErr) return res.status(500).json({ error: commitErr.message });
        res.json({ message: "Success" });
    });
});
        });
    });
});


app.get('/api/expenses/transfers', authenticateToken, (req, res) => {
    db.all("SELECT * FROM expense_transfers ORDER BY date DESC, id DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/expenses/transfer', authenticateToken, (req, res) => {
    const { amount, type, goalId, goalName } = req.body;
    if (amount === undefined || amount < 0) return res.status(400).json({ error: "Amount must be greater than or equal to 0" });
    if (type !== 'savings' && type !== 'goal') return res.status(400).json({ error: "Invalid transfer type" });

    db.get("SELECT balance FROM funds WHERE name = 'Expenses'", (err, fund) => {
        if (err || !fund) return res.status(500).json({ error: "Could not find Expenses fund" });
        if (fund.balance < amount) return res.status(400).json({ error: "Insufficient remaining balance in Expenses fund" });

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            
            // Deduct from Expenses
            db.run("UPDATE funds SET balance = MAX(0, balance - ?) WHERE name = 'Expenses'", [amount], (err) => {
                if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                
                const processTransfer = () => {
                    const date = new Date().toISOString().split('T')[0];
                    const destName = type === 'savings' ? 'Personal Savings' : goalName;
                    
                    db.run("INSERT INTO expense_transfers (date, amount, destination_type, destination_name) VALUES (?, ?, ?, ?)",
                        [date, amount, type, destName], (err) => {
                        if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
    db.run("COMMIT", (commitErr) => {
        if (commitErr) return res.status(500).json({ error: commitErr.message });
        res.json({ message: "Success" });
    });
});
                };

                if (type === 'savings') {
                    db.run("UPDATE funds SET balance = balance + ? WHERE name = 'Personal Savings'", [amount], (err) => {
                        if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                        processTransfer();
                    });
                } else if (type === 'goal') {
                    db.run("UPDATE goals SET saved_amount = saved_amount + ? WHERE id = ?", [amount, goalId], (err) => {
                        if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                        processTransfer();
                    });
                }
            });
        });
    });
});
app.get('/api/expenses/budget-funding', authenticateToken, (req, res) => {
    db.all("SELECT * FROM budget_funding ORDER BY date DESC, id DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/expenses/fund-budget', authenticateToken, (req, res) => {
    const { type, amount, sourceName, goalId, notes, targetMonth } = req.body;
    if (amount === undefined || amount < 0) return res.status(400).json({ error: "Amount must be greater than or equal to 0" });
    
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        
        const completeFunding = () => {
            let date = new Date().toISOString().split('T')[0];
            if (targetMonth) {
                const currentMonth = date.substring(0, 7);
                if (targetMonth !== currentMonth) {
                    date = `${targetMonth}-01`;
                }
            }
            db.run("INSERT INTO budget_funding (date, type, source_name, amount, notes) VALUES (?, ?, ?, ?, ?)",
                [date, type, sourceName || '', amount, notes || ''], (err) => {
                if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                
                // Add to Expenses Fund
                db.run("UPDATE funds SET balance = balance + ? WHERE name = 'Expenses'", [amount], (err) => {
                    if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
    db.run("COMMIT", (commitErr) => {
        if (commitErr) return res.status(500).json({ error: commitErr.message });
        res.json({ message: "Success" });
    });
});
            });
        };

        if (type === 'savings') {
            db.get("SELECT balance FROM funds WHERE name = 'Personal Savings'", (err, fund) => {
                if (err || !fund) { db.run("ROLLBACK"); return res.status(500).json({ error: "Could not find Personal Savings" }); }
                if (fund.balance < amount) { db.run("ROLLBACK"); return res.status(400).json({ error: "Insufficient Personal Savings balance" }); }
                
                db.run("UPDATE funds SET balance = MAX(0, balance - ?) WHERE name = 'Personal Savings'", [amount], (err) => {
                    if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                    completeFunding();
                });
            });
        } else if (type === 'goal') {
            db.get("SELECT saved_amount FROM goals WHERE id = ?", [goalId], (err, goal) => {
                if (err || !goal) { db.run("ROLLBACK"); return res.status(404).json({ error: "Goal not found" }); }
                if (goal.saved_amount < amount) { db.run("ROLLBACK"); return res.status(400).json({ error: "Insufficient goal balance" }); }
                
                db.run("UPDATE goals SET saved_amount = MAX(0, saved_amount - ?) WHERE id = ?", [amount, goalId], (err) => {
                    if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                    completeFunding();
                });
            });
        } else if (type === 'external') {
            completeFunding();
        } else {
            db.run("ROLLBACK");
            res.status(400).json({ error: "Invalid funding type" });
        }
    });
});



app.put('/api/expenses/budget-funding/:id', authenticateToken, (req, res) => {
    const { amount, notes } = req.body;
    const id = req.params.id;
    if (amount === undefined || amount < 0) return res.status(400).json({ error: "Amount must be greater than or equal to 0" });

    db.get("SELECT type, amount as oldAmount, source_name FROM budget_funding WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Record not found" });

        const { type, oldAmount, source_name } = row;
        const diff = amount - oldAmount;

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            
            // 1. Update the record
            db.run("UPDATE budget_funding SET amount = ?, notes = ? WHERE id = ?", [amount, notes || '', id], (err) => {
                if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                
                // 2. Adjust Expenses fund
                db.run("UPDATE funds SET balance = balance + ? WHERE name = 'Expenses'", [diff], (err) => {
                    if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                    
                    const completePut = () => {
                        db.run("COMMIT", (commitErr) => {
                            if (commitErr) return res.status(500).json({ error: commitErr.message });
                            res.json({ message: "Budget funding updated successfully" });
                        });
                    };

                    // 3. Adjust source if needed
                    if (type === 'savings') {
                        db.get("SELECT balance FROM funds WHERE name = 'Personal Savings'", (err, fund) => {
                            if (err || !fund) { db.run("ROLLBACK"); return res.status(500).json({ error: "Personal Savings not found" }); }
                            // the source gets -diff. (If diff is positive, we deduct more from savings. If negative, we refund savings).
                            if (fund.balance < diff) { db.run("ROLLBACK"); return res.status(400).json({ error: "Insufficient Personal Savings balance" }); }
                            
                            db.run("UPDATE funds SET balance = balance - ? WHERE name = 'Personal Savings'", [diff], (err) => {
                                if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                                completePut();
                            });
                        });
                    } else if (type === 'goal') {
                        db.get("SELECT saved_amount FROM goals WHERE name = ?", [source_name], (err, goal) => {
                            if (err || !goal) { db.run("ROLLBACK"); return res.status(404).json({ error: "Goal not found" }); }
                            if (goal.saved_amount < diff) { db.run("ROLLBACK"); return res.status(400).json({ error: "Insufficient goal balance" }); }
                            
                            db.run("UPDATE goals SET saved_amount = saved_amount - ? WHERE name = ?", [diff, source_name], (err) => {
                                if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                                completePut();
                            });
                        });
                    } else {
                        // external
                        completePut();
                    }
                });
            });
        });
    });
});

app.delete('/api/expenses/budget-funding/:id', authenticateToken, (req, res) => {
    const id = req.params.id;

    db.get("SELECT type, amount, source_name FROM budget_funding WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: "Record not found" });

        const { type, amount, source_name } = row;

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            db.run("DELETE FROM budget_funding WHERE id = ?", [id], (err) => {
                if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                
                db.run("UPDATE funds SET balance = balance - ? WHERE name = 'Expenses'", [amount], (err) => {
                    if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                    
                    const completeDel = () => {
                        db.run("COMMIT", (commitErr) => {
                            if (commitErr) return res.status(500).json({ error: commitErr.message });
                            res.json({ message: "Budget funding deleted successfully" });
                        });
                    };

                    if (type === 'savings') {
                        db.run("UPDATE funds SET balance = balance + ? WHERE name = 'Personal Savings'", [amount], (err) => {
                            if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                            completeDel();
                        });
                    } else if (type === 'goal') {
                        db.run("UPDATE goals SET saved_amount = saved_amount + ? WHERE name = ?", [amount, source_name], (err) => {
                            if (err) { db.run("ROLLBACK"); return res.status(500).json({ error: err.message }); }
                            completeDel();
                        });
                    } else {
                        completeDel();
                    }
                });
            });
        });
    });
});
// Global Error Handler Middleware
app.use((err, req, res, next) => {
    console.error('Unhandled Server Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });