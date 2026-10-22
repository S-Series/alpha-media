package service;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class PlanRepository {

    private static final RowMapper<Plan> MAPPER = (row, index) -> new Plan(
            row.getString("id"), row.getString("name"), row.getString("country"),
            row.getInt("days"), row.getInt("data_mb"),
            Plan.SimType.valueOf(row.getString("sim_type")), row.getLong("price"));

    private final JdbcTemplate jdbc;

    public PlanRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<Plan> findAll(String country, Integer days, Integer dataMb, Plan.SimType simType) {
        var sql = new StringBuilder("SELECT * FROM plans WHERE 1=1");
        var parameters = new ArrayList<Object>();
        if (country != null && !country.isBlank()) {
            sql.append(" AND position(? in country) > 0");
            parameters.add(country.trim());
        }
        if (days != null) {
            sql.append(" AND days = ?");
            parameters.add(days);
        }
        if (dataMb != null) {
            sql.append(" AND data_mb = ?");
            parameters.add(dataMb);
        }
        if (simType != null) {
            sql.append(" AND sim_type = ?");
            parameters.add(simType.name());
        }
        sql.append(" ORDER BY id");
        // 입력값은 SQL 문자열에 이어 붙이지 않고 바인딩한다.
        return jdbc.query(sql.toString(), MAPPER, parameters.toArray());
    }

    public Optional<Plan> findById(String planId) {
        return jdbc.query("SELECT * FROM plans WHERE id = ?", MAPPER, planId).stream().findFirst();
    }
}
